import * as vscode from "vscode";

export type AgentChatMessage = {
  role: "user" | "assistant";
  content: string;
  references?: string[];
  proposalActions?: boolean;
  memoryChoice?: "helpful" | "notHelpful" | "remembered";
};

export type AgentChatReply = { text: string; references?: string[]; proposalActions?: boolean };
export type AgentChatHandler = (messages: AgentChatMessage[]) => Promise<AgentChatReply>;
export type AgentChatActionHandler = (action: "apply" | "discard") => Promise<void>;
export type AgentChatContextHandler = (
  action: "select" | "clear",
) => Promise<{ paths: string[]; cancelled: boolean }>;
export type AgentMemoryActionHandler = (action: "helpful" | "notHelpful" | "remember", message: AgentChatMessage) => Promise<void>;
export type AgentChatLoadHandler = () => Promise<AgentChatMessage[]>;
export type AgentChatSaveHandler = (messages: AgentChatMessage[]) => Promise<void>;

type WebviewMessage = {
  type?: string;
  text?: string;
  action?: "apply" | "discard";
  memoryAction?: "helpful" | "notHelpful" | "remember";
  messageIndex?: number;
  contextAction?: "select" | "clear";
};

export class AgentChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private messages: AgentChatMessage[] = [];
  private busy = false;

  constructor(
    private readonly handleChat: AgentChatHandler,
    private readonly handleProposalAction: AgentChatActionHandler,
    private readonly handleContextAction: AgentChatContextHandler,
    private readonly loadMessages: AgentChatLoadHandler,
    private readonly saveMessages: AgentChatSaveHandler,
    private readonly handleMemoryAction: AgentMemoryActionHandler,
  ) {}

  private async persistMessages(): Promise<void> {
    try {
      await this.saveMessages(this.messages);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      void vscode.window.showWarningMessage(`Jambavan could not save local chat history: ${detail}`);
    }
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = this.getHtml(view.webview);
    view.webview.onDidReceiveMessage(
      (message: WebviewMessage) => void this.onMessage(message),
    );
    view.onDidDispose(() => {
      this.view = undefined;
    });
  }

  private async onMessage(message: WebviewMessage): Promise<void> {
    if (message.type === "ready") {
      this.messages = await this.loadMessages();
      await this.view?.webview.postMessage({ type: "history", messages: this.messages });
      return;
    }

    if (message.type === "memoryAction" && message.memoryAction && Number.isInteger(message.messageIndex)) {
      const target = this.messages[message.messageIndex!];
      if (!target || target.role !== "assistant") return;
      try {
        await this.handleMemoryAction(message.memoryAction, target);
        target.memoryChoice = message.memoryAction === "remember" ? "remembered" : message.memoryAction;
        await this.persistMessages();
        await this.view?.webview.postMessage({ type: "memoryActionDone", messageIndex: message.messageIndex, action: message.memoryAction });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await this.view?.webview.postMessage({ type: "error", text: `Could not save this choice locally: ${detail}` });
      }
      return;
    }

    if (message.type === "proposalAction" && message.action) {
      try {
        await this.handleProposalAction(message.action);
        this.messages = this.messages.map((item) => ({ ...item, proposalActions: false }));
        await this.view?.webview.postMessage({ type: "clearProposalActions" });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await this.view?.webview.postMessage({ type: "error", text: `Could not ${message.action} proposal: ${detail}` });
      }
      return;
    }

    if (message.type === "contextAction" && message.contextAction) {
      try {
        const result = await this.handleContextAction(message.contextAction);
        if (!result.cancelled) {
          const text = result.paths.length > 0
            ? `Chat context files selected:\n${result.paths.map((path) => `• ${path}`).join("\n")}`
            : "No extra context files are selected. Chat will use the active file and basic workspace overview.";
          this.messages.push({ role: "assistant", content: text });
          this.messages = this.messages.slice(-40);
          await this.persistMessages();
          await this.view?.webview.postMessage({ type: "contextUpdated", text });
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await this.view?.webview.postMessage({ type: "error", text: `Could not update repository context: ${detail}` });
      }
      return;
    }

    const text = message.type === "send" ? message.text?.trim() : undefined;
    if (!text || this.busy || text.length > 2_000) {
      return;
    }

    this.busy = true;
    this.messages.push({ role: "user", content: text });
    this.messages = this.messages.slice(-40);
    await this.persistMessages();
    await this.view?.webview.postMessage({ type: "busy", value: true });

    try {
      const reply = await this.handleChat(this.messages.slice(-5));
      this.messages.push({ role: "assistant", content: reply.text, references: reply.references, proposalActions: reply.proposalActions });
      this.messages = this.messages.slice(-40);
      await this.persistMessages();
      await this.view?.webview.postMessage({ type: "assistant", text: reply.text, references: reply.references, proposalActions: reply.proposalActions, messageIndex: this.messages.length - 1 });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const explanation = `I couldn't complete that request: ${detail}`;
      this.messages.push({ role: "assistant", content: explanation });
      this.messages = this.messages.slice(-40);
      await this.persistMessages();
      await this.view?.webview.postMessage({ type: "error", text: explanation });
    } finally {
      this.busy = false;
      await this.view?.webview.postMessage({ type: "busy", value: false });
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>Private Agent Chat</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      padding: 0;
      margin: 0;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    .shell { min-height: 100vh; display: flex; flex-direction: column; }
    header { padding: 14px 14px 10px; border-bottom: 1px solid var(--vscode-panel-border); }
    header h1 { margin: 0 0 4px; font-size: 14px; font-weight: 600; }
    header p { margin: 0; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .context-controls { display: flex; gap: 6px; padding-top: 9px; }
    .context-controls button { padding: 3px 8px; font-size: 11px; }
    #messages { flex: 1; overflow-y: auto; padding: 14px 10px; }
    .welcome { color: var(--vscode-descriptionForeground); line-height: 1.5; padding: 8px 4px; }
    .message { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.5; padding: 9px 10px; margin: 0 0 10px; border-radius: 6px; }
    .user { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
    .assistant { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); }
    .error { color: var(--vscode-errorForeground); }
    #status { min-height: 18px; padding: 0 14px 7px; color: var(--vscode-descriptionForeground); font-size: 11px; }
    form { padding: 8px; border-top: 1px solid var(--vscode-panel-border); }
    textarea {
      display: block; width: 100%; min-height: 72px; max-height: 180px; resize: vertical;
      padding: 9px; color: var(--vscode-input-foreground); background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-widget-border)); border-radius: 5px;
      font: inherit; outline-color: var(--vscode-focusBorder);
    }
    .controls { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-top: 7px; }
    .hint { color: var(--vscode-descriptionForeground); font-size: 10px; }
    button {
      padding: 5px 12px; color: var(--vscode-button-foreground); background: var(--vscode-button-background);
      border: 0; border-radius: 4px; font: inherit; cursor: pointer;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: .55; cursor: default; }
  </style>
</head>
<body>
  <main class="shell">
    <header>
      <h1>Self-Evolving Agent</h1>
      <p>Private chat powered by your local Ollama model</p>
      <div class="context-controls">
        <button id="select-context" type="button">Add context files</button>
        <button id="clear-context" type="button">Clear context</button>
      </div>
    </header>
    <section id="messages" aria-live="polite" aria-label="Conversation">
      <div id="welcome" class="welcome">Ask about your project. Type <code>/scan</code> to build or update local repository notes, or type <code>/edit</code> followed by a requested change to propose a file edit.</div>
    </section>
    <div id="status" role="status"></div>
    <form id="chat-form">
      <textarea id="prompt" maxlength="2000" aria-label="Message" placeholder="Ask about your code..."></textarea>
      <div class="controls">
        <span class="hint">Enter to send · Shift+Enter for a new line</span>
        <button id="send" type="submit">Send</button>
      </div>
    </form>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messages = document.getElementById('messages');
    const welcome = document.getElementById('welcome');
    const status = document.getElementById('status');
    const prompt = document.getElementById('prompt');
    const sendButton = document.getElementById('send');
    const form = document.getElementById('chat-form');
    document.getElementById('select-context').addEventListener('click', () => {
      vscode.postMessage({ type: 'contextAction', contextAction: 'select' });
    });
    document.getElementById('clear-context').addEventListener('click', () => {
      vscode.postMessage({ type: 'contextAction', contextAction: 'clear' });
    });

    function addMessage(role, text, isError = false, proposalActions = false, references = [], messageIndex = -1, memoryChoice = '') {
      welcome.hidden = true;
      const article = document.createElement('article');
      article.className = 'message ' + role + (isError ? ' error' : '');
      if (messageIndex >= 0) article.dataset.messageIndex = String(messageIndex);
      article.textContent = text;
      messages.appendChild(article);
      if (role === 'assistant' && !isError && messageIndex >= 0) {
        if (references.length) {
          const details = document.createElement('details');
          const summary = document.createElement('summary');
          summary.textContent = 'Context sent to the model (' + references.length + ' items)';
          const list = document.createElement('ul');
          for (const path of references) { const item = document.createElement('li'); item.textContent = path; list.appendChild(item); }
          details.append(summary, list);
          article.appendChild(details);
        }
        const memoryControls = document.createElement('div');
        memoryControls.className = 'controls';
        for (const [label, action] of [['Helpful', 'helpful'], ['Not helpful', 'notHelpful'], ['Remember', 'remember']]) {
          const button = document.createElement('button');
          button.type = 'button'; button.textContent = label; button.disabled = memoryChoice !== '';
          button.addEventListener('click', () => {
            memoryControls.querySelectorAll('button').forEach((item) => item.disabled = true);
            vscode.postMessage({ type: 'memoryAction', memoryAction: action, messageIndex });
          });
          memoryControls.appendChild(button);
        }
        article.appendChild(memoryControls);
      }
      if (proposalActions) {
        const controls = document.createElement('div');
        controls.className = 'controls';
        for (const [label, action] of [['Apply proposal', 'apply'], ['Discard', 'discard']]) {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = label;
          button.addEventListener('click', () => {
            button.disabled = true;
            vscode.postMessage({ type: 'proposalAction', action });
          });
          controls.appendChild(button);
        }
        article.appendChild(controls);
      }
      messages.scrollTop = messages.scrollHeight;
    }

    function setBusy(value) {
      prompt.disabled = value;
      sendButton.disabled = value;
      status.textContent = value ? 'Thinking with your local model…' : '';
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = prompt.value.trim();
      if (!text || sendButton.disabled) return;
      addMessage('user', text);
      prompt.value = '';
      setBusy(true);
      vscode.postMessage({ type: 'send', text });
    });

    prompt.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        form.requestSubmit();
      }
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'history') {
        messages.querySelectorAll('.message').forEach((item) => item.remove());
        welcome.hidden = message.messages.length > 0;
        for (let index = 0; index < message.messages.length; index++) {
          const item = message.messages[index];
          addMessage(item.role, item.content, false, item.proposalActions, item.references || [], item.role === 'assistant' ? index : -1, item.memoryChoice || '');
        }
      } else if (message.type === 'assistant') {
        addMessage('assistant', message.text, false, message.proposalActions, message.references || [], message.messageIndex);
      } else if (message.type === 'error') {
        addMessage('assistant', message.text, true);
      } else if (message.type === 'busy') {
        setBusy(message.value);
      } else if (message.type === 'clearProposalActions') {
        messages.querySelectorAll('.controls').forEach((item) => item.remove());
      } else if (message.type === 'contextUpdated') {
        addMessage('assistant', message.text);
      } else if (message.type === 'memoryActionDone') {
        messages.querySelector('[data-message-index="' + message.messageIndex + '"]')?.querySelectorAll('button').forEach((button) => button.disabled = true);
        status.textContent = message.action === 'remember' ? 'Saved in local memory for this repository.' : 'Feedback saved in local memory.';
        setTimeout(() => { if (!sendButton.disabled) status.textContent = ''; }, 2500);
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () => possible[Math.floor(Math.random() * possible.length)]).join("");
}
