# Jambavan — Self-Evolving Private Coding Agent

Jambavan is a coding assistant designed to adapt to the coding style and repositories a developer works with, and help them code. This early local-first prototype adds a private VS Code chat view connected directly to Ollama.

## Run the extension in VS Code

1. Open this project folder in VS Code.
2. Open VS Code's terminal using **Terminal → New Terminal**.
3. Run `npm install` once to install the project tools.
4. Press `F5`. VS Code compiles the extension and opens a second window called **Extension Development Host**.
5. In that second window, click the **Private Agent** speech-bubble icon in the Activity Bar.
6. Type a question in the chat box and press `Enter`. Use `Shift+Enter` for a new line.
7. To request a code change in chat, open the target file and send `/edit` followed by the requested change, for example `/edit add input validation`.
8. Review the side-by-side diff. The original file stays unchanged until you choose **Apply proposal** in chat; **Discard** closes out the proposal. Applying updates the editor buffer but does not save it, so press `Cmd+S` when ready.
9. You can also run **Propose Edit to Active File** from the Command Palette.

The chat keeps the last few messages for follow-up questions while the extension is running. It does not save conversation history between VS Code sessions.

Ollama must be running and have the selected model downloaded. In VS Code settings, set **Self-Evolving Agent: Model** to the exact tag shown by `ollama list`. The default is `qwen3.5:9b`, matching the installed Qwen 3.5 9B model. The server URL defaults to `http://localhost:11434`.

## What this first slice teaches

- A Webview View provides a chat layout in the VS Code Activity Bar. It sends and receives messages through VS Code's extension messaging API.
- VS Code's workspace APIs let the extension discover file paths and read project guidance.
- Ollama exposes a local HTTP chat endpoint, so the extension can use the installed model without a cloud API.
- For questions, the extension sends up to 50 file paths per workspace, up to 2,500 characters of project guidance/metadata per workspace, and up to 6,000 characters from the active file.
- For chat messages, it sends up to 15 file paths, up to 800 characters of project instructions, up to 3,500 characters from the active file, and at most four recent conversation messages.
- For edit proposals, it sends only the active file and up to 1,200 characters of `AGENTS.md` or `Instructions.md` guidance. Files over 7,000 characters are currently refused so the model can return the complete file within its context window.
- Common environment, key, certificate, and secret-named files are filtered out by filename. This is a basic precaution, not a complete secret scanner.
- The extension does not send every source file, run tests, or save memory yet. Edit proposals appear in an untitled preview and require an explicit apply action before the editor buffer changes.
- The `/edit` chat action uses the same full-file proposal format and size limit as the Command Palette edit action.

The request is sent to the configured Ollama URL, which defaults to the local machine. Check that setting before use. Avoid putting secrets in prompts; filename filtering can miss secrets stored in ordinary files.

## Planned learning path

1. Connect VS Code to Ollama and provide bounded workspace context.
2. Add explicit repository context selection and explain how files are chosen.
3. Add user-approved test commands and feed their output back to the model.
4. Save and inspect project-specific memory in the workspace.
