# Jambavan learning journal

This journal records the project as I build it. I’m learning by shipping small pieces, trying them in VS Code, and writing down what broke and what I changed. The features below describe the current prototype, not a finished product.

## 1. Starting with a VS Code extension

I began with a TypeScript extension instead of a separate application. This taught me how VS Code extensions are activated, how `package.json` contributes commands and views, and how the Extension Development Host differs from my regular VS Code window.

**Where to look:** `package.json`, `.vscode/launch.json`, and `src/extension.ts`.

## 2. Connecting a local model

I connected the extension to Ollama's chat endpoint and configured Qwen 3.5 9B as the default model. I learned to check that the Ollama server is reachable and that the model tag in VS Code settings matches the installed model.

**Where to look:** `src/extension.ts` and the `selfEvolvingAgent.ollamaUrl` and `selfEvolvingAgent.model` settings in `package.json`.

## 3. Building a chat view

I created a chat panel in the VS Code Activity Bar and connected the webview to the extension process with VS Code's message API. I also added bounded workspace context so the model gets selected information instead of the entire repository.

**Where to look:** `src/chatView.ts` and `collectWorkspaceContext` in `src/extension.ts`.

## 4. Asking for code changes safely

I added `/edit` to request a full-file proposal. Jambavan opens the proposed content beside the original in a diff and waits for me to apply or discard it.

**Where to look:** `createChatProposal` and the apply/discard commands in `src/extension.ts`.

## 5. Giving Jambavan repository knowledge

I wanted Jambavan to keep notes it could use in later conversations. The scanner creates `JAMBAVAN_NOTES.md` for people and `.jambavan/scan-index.json` for file hashes and summaries. It can skip files that have not changed and refresh notes after local edits.

**Where to look:** `src/repoKnowledge.ts` and the scan scheduling logic in `src/extension.ts`.

## 6. Handling long scans and preserving progress

During a scan, Ollama timed out while generating a summary. I changed scanner requests to stream the model's response and save each completed summary before moving to the next file.

**Where to look:** `readOllamaStream` and `updateRepositoryNotes` in `src/repoKnowledge.ts`.

## 7. Keeping chat and choices between sessions

I added local chat history and actions for marking an answer helpful, not helpful, or worth remembering. Relevant saved choices can be included in later model requests. Each answer also shows the context items Jambavan sent.

**Where to look:** `src/localMemory.ts`, `src/chatView.ts`, and the chat provider in `src/extension.ts`.

## What I want to learn next

- How to rank repository files and notes by relevance without sending too much context.
- How to let a user inspect and clear saved chat and preference data.
- How to ask before running a test command, capture its output, and explain failures.
- How to summarize local Git changes and distinguish that from monitoring a remote pull request.
- How to package the extension for regular VS Code use after the development workflow is stable.

## A note on writing this journal

This journal is written from my perspective as the builder. I’ll update it when I complete or change a milestone, and I’ll keep limitations visible instead of describing planned features as finished ones.
