import * as vscode from "vscode";

export type AgentChatMessage = {
  role: "user" | "assistant";
  content: string;
  proposalActions?: boolean;
};

export type AgentChatReply = { text: string; proposalActions?: boolean };
export type AgentChatHandler = (messages: AgentChatMessage[]) => Promise<AgentChatReply>;
export type AgentChatActionHandler = (action: "apply" | "discard") => Promise<void>;

type WebviewMessage = {
  type?: string;
  text?: string;
  action?: "apply" | "discard";
};

export class AgentChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private messages: AgentChatMessage[] = [];
  private busy = false;

  constructor(
    private readonly handleChat: AgentChatHandler,
    private readonly handleProposalAction: AgentChatActionHandler,
  ) {}

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
      await this.view?.webview.postMessage({ type: "history", messages: this.messages });
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

    const text = message.type === "send" ? message.text?.trim() : undefined;
    if (!text || this.busy || text.length > 2_000) {
      return;
    }

    this.busy = true;
    this.messages.push({ role: "user", content: text });
    await this.view?.webview.postMessage({ type: "busy", value: true });

    try {
      const reply = await this.handleChat(this.messages.slice(-5));
      this.messages.push({ role: "assistant", content: reply.text, proposalActions: reply.proposalActions });
      this.messages = this.messages.slice(-10);
      await this.view?.webview.postMessage({ type: "assistant", text: reply.text, proposalActions: reply.proposalActions });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const explanation = `I couldn't complete that request: ${detail}`;
      this.messages.push({ role: "assistant", content: explanation });
      this.messages = this.messages.slice(-10);
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
    </header>
    <section id="messages" aria-live="polite" aria-label="Conversation">
      <div id="welcome" class="welcome">Ask about your project, or type <code>/edit</code> followed by a requested change to create a reviewable proposal for the open file.</div>
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

    function addMessage(role, text, isError = false, proposalActions = false) {
      welcome.hidden = true;
      const article = document.createElement('article');
      article.className = 'message ' + role + (isError ? ' error' : '');
      article.textContent = text;
      messages.appendChild(article);
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
        for (const item of message.messages) addMessage(item.role, item.content, false, item.proposalActions);
      } else if (message.type === 'assistant') {
        addMessage('assistant', message.text, false, message.proposalActions);
      } else if (message.type === 'error') {
        addMessage('assistant', message.text, true);
      } else if (message.type === 'busy') {
        setBusy(message.value);
      } else if (message.type === 'clearProposalActions') {
        messages.querySelectorAll('.controls').forEach((item) => item.remove());
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
