import { createHash } from "node:crypto";
import * as vscode from "vscode";

export type LocalChatMessage = {
  role: "user" | "assistant";
  content: string;
  references?: string[];
  proposalActions?: boolean;
};

export type MemoryChoice = {
  kind: "helpful" | "notHelpful" | "remembered";
  text: string;
  date: string;
};

type StoredMemory = { messages: LocalChatMessage[]; choices: MemoryChoice[] };

const MAX_SAVED_MESSAGES = 100;
const MAX_CHOICES = 100;

export class LocalMemoryStore {
  private readonly uri: vscode.Uri;
  private readonly storageRoot: vscode.Uri;
  private data: StoredMemory = { messages: [], choices: [] };

  constructor(storageRoot: vscode.Uri, workspaceKey: string) {
    this.storageRoot = storageRoot;
    const id = createHash("sha256").update(workspaceKey).digest("hex").slice(0, 24);
    this.uri = vscode.Uri.joinPath(storageRoot, `memory-${id}.json`);
  }

  async load(): Promise<LocalChatMessage[]> {
    try {
      const parsed = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(this.uri)).toString("utf8")) as StoredMemory;
      this.data = {
        messages: Array.isArray(parsed.messages) ? parsed.messages.slice(-MAX_SAVED_MESSAGES) : [],
        choices: Array.isArray(parsed.choices) ? parsed.choices.slice(-MAX_CHOICES) : [],
      };
    } catch {
      this.data = { messages: [], choices: [] };
    }
    return this.data.messages;
  }

  async saveMessages(messages: LocalChatMessage[]): Promise<void> {
    this.data.messages = messages.slice(-MAX_SAVED_MESSAGES);
    await this.write();
  }

  async recordChoice(kind: MemoryChoice["kind"], text: string): Promise<void> {
    this.data.choices.push({ kind, text: text.slice(0, 2_000), date: new Date().toISOString() });
    this.data.choices = this.data.choices.slice(-MAX_CHOICES);
    await this.write();
  }

  getRelevantChoices(query: string): string {
    const words = new Set(query.toLowerCase().split(/[^a-z0-9_]+/).filter((word) => word.length > 2));
    const ranked = this.data.choices.map((choice) => {
      const textWords = choice.text.toLowerCase().split(/[^a-z0-9_]+/);
      const score = textWords.reduce((sum, word) => sum + (words.has(word) ? 1 : 0), 0);
      return { choice, score };
    }).sort((a, b) => b.score - a.score || b.choice.date.localeCompare(a.choice.date));
    const selected = ranked.filter((item) => item.score > 0).slice(0, 5);
    if (selected.length === 0) return "";
    return selected.map(({ choice }) => `- [${choice.kind}] ${choice.text}`).join("\n").slice(0, 2_500);
  }

  private async write(): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.storageRoot);
    await vscode.workspace.fs.writeFile(this.uri, Buffer.from(JSON.stringify(this.data, null, 2), "utf8"));
  }
}
