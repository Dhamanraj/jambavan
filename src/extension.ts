import * as vscode from "vscode";
import { AgentChatMessage, AgentChatViewProvider } from "./chatView";

type OllamaChatResponse = {
  message?: {
    content?: string;
  };
  error?: string;
};

type WorkspaceContext = {
  text: string;
  includedFiles: string[];
};

type PendingProposal = {
  uri: vscode.Uri;
  path: string;
  content: string;
  version: number;
};

const MAX_INDEXED_PATHS = 50;
const MAX_GUIDANCE_CHARS = 2_500;
const MAX_ACTIVE_FILE_CHARS = 6_000;
const MAX_PROPOSAL_FILE_CHARS = 7_000;
const MAX_PROPOSAL_GUIDANCE_CHARS = 1_200;
const guidanceFileNames = new Set([
  "AGENTS.md",
  "README.md",
  "CONTRIBUTING.md",
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
]);

function isSensitivePath(path: string): boolean {
  const name = path.split("/").at(-1)?.toLowerCase() ?? "";
  return (
    name.startsWith(".env") ||
    name.endsWith(".env") ||
    name.includes("secret") ||
    name.includes("credential") ||
    name.includes("password") ||
    name.includes("token") ||
    /api[-_]?key/.test(name) ||
    /\.(pem|key|p12|pfx|der)$/.test(name)
  );
}

async function callOllama(
  baseUrl: string,
  model: string,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
): Promise<string> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: false, messages }),
  });

  const result = (await response.json()) as OllamaChatResponse;
  if (!response.ok) {
    throw new Error(result.error ?? `Ollama returned HTTP ${response.status}`);
  }

  const answer = result.message?.content?.trim();
  if (!answer) {
    throw new Error("Ollama returned an empty response.");
  }
  return answer;
}

function reportOllamaError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  void vscode.window.showErrorMessage(
    `Could not reach Ollama. Check that it is running and that the model tag is correct. Details: ${message}`,
  );
}

async function collectWorkspaceContext(
  activeEditor: vscode.TextEditor | undefined,
  purpose: "question" | "proposal" | "chat" = "question",
): Promise<WorkspaceContext> {
  const sections: string[] = [];
  const includedFiles: string[] = [];
  const folders = vscode.workspace.workspaceFolders ?? [];

  if (folders.length === 0) {
    sections.push("No folder is open in this VS Code window.");
  }

  for (const folder of folders) {
    if (purpose === "question" || purpose === "chat") {
      const maxIndexedPaths = purpose === "chat" ? 15 : MAX_INDEXED_PATHS;
      const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, "**/*"),
        "**/{.git,node_modules,dist,build,coverage,.venv}/**",
        maxIndexedPaths + 1,
      );
      const paths = files
        .map((uri) => vscode.workspace.asRelativePath(uri))
        .filter((path) => !isSensitivePath(path));
      const truncated = paths.length > maxIndexedPaths;
      const visiblePaths = paths.slice(0, maxIndexedPaths);

      sections.push(
        `Workspace: ${folder.name}\nRepository file paths${truncated ? ` (first ${maxIndexedPaths})` : ""}:\n${visiblePaths.join("\n") || "(no files found)"}`,
      );
      includedFiles.push(...visiblePaths);
    } else {
      sections.push(`Workspace: ${folder.name}`);
    }

    const guidanceUris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(
        folder,
        purpose === "proposal" || purpose === "chat"
          ? "**/{AGENTS.md,Instructions.md}"
          : "**/{AGENTS.md,README.md,CONTRIBUTING.md}",
      ),
      "**/{.git,node_modules,dist,build,coverage,.venv}/**",
      purpose === "proposal" ? 6 : purpose === "chat" ? 4 : 20,
    );
    const rootEntries =
      purpose !== "question"
        ? []
        : await Promise.all(
            [...guidanceFileNames]
              .filter((name) => !["AGENTS.md", "README.md", "CONTRIBUTING.md"].includes(name))
              .map(async (name) => {
                const uri = vscode.Uri.joinPath(folder.uri, name);
                try {
                  await vscode.workspace.fs.stat(uri);
                  return uri;
                } catch {
                  return undefined;
                }
              }),
          );
    const guidance = [...guidanceUris, ...rootEntries.filter((uri): uri is vscode.Uri => !!uri)];
    let remainingGuidanceChars =
      purpose === "proposal"
        ? MAX_PROPOSAL_GUIDANCE_CHARS
        : purpose === "chat"
          ? 800
          : MAX_GUIDANCE_CHARS;
    const guidanceText: string[] = [];

    for (const uri of guidance) {
      const relativePath = vscode.workspace.asRelativePath(uri);
      if (isSensitivePath(relativePath) || remainingGuidanceChars <= 0) {
        continue;
      }
      try {
        const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
        const excerpt = content.slice(0, remainingGuidanceChars);
        guidanceText.push(`--- ${relativePath} ---\n${excerpt}`);
        remainingGuidanceChars -= excerpt.length;
        includedFiles.push(relativePath);
      } catch {
        // Unreadable or non-text files are omitted from model context.
      }
    }

    if (guidanceText.length > 0) {
      sections.push(`Project guidance and metadata:\n${guidanceText.join("\n\n")}`);
    }
  }

  if (activeEditor) {
      const relativePath = vscode.workspace.asRelativePath(activeEditor.document.uri);
      if (isSensitivePath(relativePath)) {
        sections.push(`Active file ${relativePath} was omitted because its name looks sensitive.`);
      } else {
        const content = activeEditor.document.getText();
        const maxActiveChars =
          purpose === "proposal"
            ? MAX_PROPOSAL_FILE_CHARS
            : purpose === "chat"
              ? 3_500
              : MAX_ACTIVE_FILE_CHARS;
        const truncated = content.length > maxActiveChars;
        sections.push(
          `Active file: ${relativePath}${truncated ? ` (truncated to ${maxActiveChars} characters)` : ""}\n${content.slice(0, maxActiveChars)}`,
      );
      includedFiles.push(relativePath);
    }
  } else {
    sections.push("No file is currently open in the editor.");
  }

  return { text: sections.join("\n\n"), includedFiles: [...new Set(includedFiles)] };
}

export function activate(context: vscode.ExtensionContext): void {
  let pendingProposal: PendingProposal | undefined;
  const createChatProposal = async (task: string): Promise<void> => {
    if (pendingProposal) {
      throw new Error("Apply or discard the existing proposal before creating another.");
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      throw new Error("Open the file you want changed, then try /edit again.");
    }
    const relativePath = vscode.workspace.asRelativePath(editor.document.uri);
    if (isSensitivePath(relativePath)) {
      throw new Error("This file name looks sensitive, so it will not be sent to the model.");
    }
    if (editor.document.getText().length > MAX_PROPOSAL_FILE_CHARS) {
      throw new Error(`This file is longer than ${MAX_PROPOSAL_FILE_CHARS} characters; choose a smaller file for now.`);
    }

    const originalVersion = editor.document.version;
    const config = vscode.workspace.getConfiguration("selfEvolvingAgent");
    const baseUrl = config.get<string>("ollamaUrl", "http://localhost:11434");
    const model = config.get<string>("model", "qwen3.5:9b");
    const workspaceContext = await collectWorkspaceContext(editor, "proposal");
    const answer = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Generating an edit proposal with ${model}...`,
        cancellable: false,
      },
      () => callOllama(baseUrl, model, [
        {
          role: "system",
          content: "Return the complete replacement of the active file, preserving all unrelated code. Output only <updated_file>, a newline, the file contents, a newline, then </updated_file>. No markdown fences or explanation.",
        },
        { role: "user", content: `Task:\n${task}\n\nRepository context:\n${workspaceContext.text}` },
      ]),
    );
    const match = answer.match(/<updated_file>\r?\n([\s\S]*?)\r?\n<\/updated_file>/);
    if (!match) {
      throw new Error("The model did not return a complete file between the required markers. Try a simpler change.");
    }
    if (editor.document.version !== originalVersion) {
      throw new Error("The active file changed while the model was working. Run the proposal again.");
    }

    const proposal = await vscode.workspace.openTextDocument({
      language: editor.document.languageId,
      content: match[1],
    });
    pendingProposal = { uri: editor.document.uri, path: relativePath, content: match[1], version: originalVersion };
    await vscode.commands.executeCommand("vscode.diff", editor.document.uri, proposal.uri, `Proposed edit: ${relativePath}`);
  };

  const chatProvider = new AgentChatViewProvider(async (conversation: AgentChatMessage[]) => {
    const latest = conversation.at(-1);
    if (latest?.role === "user" && latest.content.toLowerCase().startsWith("/edit")) {
      const task = latest.content.slice(5).trim();
      if (!task) {
        throw new Error("Add the change after /edit, for example: /edit add input validation.");
      }
      await createChatProposal(task);
      return { text: "I created a proposal and opened the diff for review. Your file has not changed. Use the buttons below to apply or discard it.", proposalActions: true };
    }

    const workspaceContext = await collectWorkspaceContext(vscode.window.activeTextEditor, "chat");
    const config = vscode.workspace.getConfiguration("selfEvolvingAgent");
    const baseUrl = config.get<string>("ollamaUrl", "http://localhost:11434");
    const model = config.get<string>("model", "qwen3.5:9b");
    const recentConversation = conversation.slice(-4).map((message) => ({
      role: message.role,
      content: message.content.slice(-1_000),
    }));

    const text = await callOllama(baseUrl, model, [
      {
        role: "system",
        content:
          "You are a private local coding assistant. Answer conversationally, use the project context, and be honest about what you have not edited or tested.",
      },
      {
        role: "system",
        content: `Current workspace context:\n${workspaceContext.text}`,
      },
      ...recentConversation,
    ]);
    return { text };
  }, async (action) => {
    await vscode.commands.executeCommand(
      action === "apply" ? "selfEvolvingAgent.applyProposal" : "selfEvolvingAgent.discardProposal",
    );
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("selfEvolvingAgent.chat", chatProvider),
  );

  const command = vscode.commands.registerCommand(
    "selfEvolvingAgent.ask",
    async () => {
      const task = await vscode.window.showInputBox({
        prompt: "What would you like the local coding agent to help with?",
        placeHolder: "Explain this file, find a bug, suggest a change...",
        ignoreFocusOut: true,
      });

      if (!task) {
        return;
      }

      let workspaceContext: WorkspaceContext;
      try {
        workspaceContext = await collectWorkspaceContext(vscode.window.activeTextEditor);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Could not read workspace context: ${message}`);
        return;
      }

      const config = vscode.workspace.getConfiguration("selfEvolvingAgent");
      const baseUrl = config.get<string>("ollamaUrl", "http://localhost:11434");
      const model = config.get<string>("model", "qwen3.5:9b");

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Asking local model (${model})...`,
          cancellable: false,
        },
        async () => {
          try {
            const answer = await callOllama(baseUrl, model, [
              {
                role: "system",
                content:
                  "You are a private coding assistant. Use the supplied repository context. Explain your reasoning clearly and suggest concrete changes, but do not claim to have edited or tested files.",
              },
              {
                role: "user",
                content: `Task:\n${task}\n\nRepository context:\n${workspaceContext.text}`,
              },
            ]);

            const output = vscode.window.createOutputChannel("Self-Evolving Agent");
            output.appendLine(`Task: ${task}\n`);
            output.appendLine(
              `Context sent (${workspaceContext.includedFiles.length} files):\n${workspaceContext.includedFiles.join("\n") || "No files"}\n`,
            );
            output.appendLine(answer);
            output.show(true);
          } catch (error) {
            reportOllamaError(error);
          }
        },
      );
    },
  );

  const proposeEditCommand = vscode.commands.registerCommand(
    "selfEvolvingAgent.proposeEdit",
    async () => {
      if (pendingProposal) {
        void vscode.window.showWarningMessage(
          "There is already a pending proposal. Apply or discard it before creating another.",
        );
        return;
      }

      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showWarningMessage("Open a file before asking for an edit proposal.");
        return;
      }

      const relativePath = vscode.workspace.asRelativePath(editor.document.uri);
      if (isSensitivePath(relativePath)) {
        void vscode.window.showWarningMessage(
          "This file name looks sensitive, so the agent will not send it to the model.",
        );
        return;
      }
      if (editor.document.getText().length > MAX_PROPOSAL_FILE_CHARS) {
        void vscode.window.showWarningMessage(
          `This file is longer than ${MAX_PROPOSAL_FILE_CHARS} characters. Edit proposals currently need the complete file to fit in the local model's context, so choose a smaller file for now.`,
        );
        return;
      }

      const task = await vscode.window.showInputBox({
        prompt: `What change should the agent propose for ${relativePath}?`,
        placeHolder: "Fix a bug, add validation, refactor a function...",
        ignoreFocusOut: true,
      });
      if (!task) {
        return;
      }

      const originalVersion = editor.document.version;
      const config = vscode.workspace.getConfiguration("selfEvolvingAgent");
      const baseUrl = config.get<string>("ollamaUrl", "http://localhost:11434");
      const model = config.get<string>("model", "qwen3.5:9b");
      let workspaceContext: WorkspaceContext;
      try {
        workspaceContext = await collectWorkspaceContext(editor, "proposal");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Could not read workspace context: ${message}`);
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Generating an edit proposal with ${model}...`,
          cancellable: false,
        },
        async () => {
          try {
            const answer = await callOllama(baseUrl, model, [
              {
                role: "system",
                content:
                  "Return the complete replacement of the active file, preserving all unrelated code. Output only <updated_file>, a newline, the file contents, a newline, then </updated_file>. No markdown fences or explanation.",
              },
              {
                role: "user",
                content: `Task:\n${task}\n\nRepository context:\n${workspaceContext.text}`,
              },
            ]);

            const match = answer.match(/<updated_file>\r?\n([\s\S]*?)\r?\n<\/updated_file>/);
            if (!match) {
              throw new Error(
                "The model did not return a complete file between the required <updated_file> markers. Try asking for a simpler change.",
              );
            }
            if (editor.document.version !== originalVersion) {
              throw new Error("The active file changed while the model was working. Run the proposal again.");
            }

            const proposal = await vscode.workspace.openTextDocument({
              language: editor.document.languageId,
              content: match[1],
            });
            pendingProposal = {
              uri: editor.document.uri,
              path: relativePath,
              content: match[1],
              version: originalVersion,
            };
            await vscode.commands.executeCommand(
              "vscode.diff",
              editor.document.uri,
              proposal.uri,
              `Proposed edit: ${relativePath}`,
            );
            const choice = await vscode.window.showInformationMessage(
              "Review the diff. Your file is unchanged until you apply the proposal.",
              "Apply Proposal",
              "Discard Proposal",
            );
            if (choice === "Apply Proposal") {
              await vscode.commands.executeCommand("selfEvolvingAgent.applyProposal");
            } else if (choice === "Discard Proposal") {
              pendingProposal = undefined;
              void vscode.window.showInformationMessage("Proposal discarded.");
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`Could not create the edit proposal: ${message}`);
          }
        },
      );
    },
  );

  const applyProposalCommand = vscode.commands.registerCommand(
    "selfEvolvingAgent.applyProposal",
    async () => {
      const proposal = pendingProposal;
      if (!proposal) {
        void vscode.window.showInformationMessage("There is no pending proposal to apply.");
        return;
      }

      let document: vscode.TextDocument;
      try {
        document = await vscode.workspace.openTextDocument(proposal.uri);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Could not open ${proposal.path}: ${message}`);
        return;
      }

      if (document.version !== proposal.version) {
        pendingProposal = undefined;
        void vscode.window.showWarningMessage(
          `The file ${proposal.path} changed after the proposal was created. Create a new proposal before applying it.`,
        );
        return;
      }

      const confirmation = await vscode.window.showWarningMessage(
        `Apply the reviewed proposal to ${proposal.path}? This changes the editor buffer but does not save the file.`,
        { modal: true },
        "Apply Changes",
      );
      if (confirmation !== "Apply Changes") {
        return;
      }

      if (document.version !== proposal.version) {
        pendingProposal = undefined;
        void vscode.window.showWarningMessage(
          `The file ${proposal.path} changed while you were reviewing. The proposal was not applied.`,
        );
        return;
      }

      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        proposal.uri,
        new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
        proposal.content,
      );
      const applied = await vscode.workspace.applyEdit(edit);
      pendingProposal = undefined;

      if (!applied) {
        void vscode.window.showErrorMessage(`VS Code could not apply the proposal to ${proposal.path}.`);
        return;
      }
      void vscode.window.showInformationMessage(
        `Proposal applied to ${proposal.path}. Review the file and save it with Cmd+S when ready.`,
      );
    },
  );

  const discardProposalCommand = vscode.commands.registerCommand(
    "selfEvolvingAgent.discardProposal",
    () => {
      if (!pendingProposal) {
        void vscode.window.showInformationMessage("There is no pending proposal to discard.");
        return;
      }
      pendingProposal = undefined;
      void vscode.window.showInformationMessage("Proposal discarded. Your file was not changed.");
    },
  );

  context.subscriptions.push(command, proposeEditCommand, applyProposalCommand, discardProposalCommand);
}

export function deactivate(): void {}
