# Jambavan

### Learning to build a private coding assistant, one feature at a time

I’m building Jambavan to learn how AI coding tools work from the inside. It is an experimental VS Code extension that connects to a local Ollama model, reads bounded context from the repository I have open, and keeps repository notes that can help with later questions.

This repository is part working prototype and part learning journal. I’m documenting what I add, what I learn, and where the current design still has limits. Jambavan is not a trained or autonomous coding system: its “learning” currently means saving repository summaries, chat history, and feedback as local data.

**Source code:** [github.com/Dhamanraj/jambavan](https://github.com/Dhamanraj/jambavan)

## What it can do today

- Chat with an Ollama model from a VS Code Activity Bar view. The default model is `qwen3.5:9b`.
- Include a limited amount of workspace context, selected files, and generated repository notes in a request. Each assistant response shows the context items sent to the model.
- Scan supported repository files and write a readable `JAMBAVAN_NOTES.md` plus a hidden `.jambavan/scan-index.json`. Hashes let it skip unchanged files.
- Update notes after supported file changes and when VS Code starts. If a GitHub PR is merged, Jambavan sees those changes after they are pulled or checked out locally; it does not connect to GitHub directly.
- Show a **Cancel** action while scanning or updating notes. Cancelling stops the current Ollama request and any queued automatic scan for that repository; summaries already completed are kept.
- Save recent chat history and feedback in VS Code extension storage for the workspace. Mark a response **Helpful**, **Not helpful**, or **Remember** to give future relevant answers more user-specific context.
- Propose an edit to the active file and show a diff for review. Applying a proposal changes the editor buffer; I still need to review and save it.

## Follow the build

- [Learning journal](docs/learning-journal.md): the milestones, lessons, debugging discoveries, and next steps.
- [How Jambavan works](docs/architecture.md): a tour of the extension, repository scan, local memory, and edit review flow.

## Run the development version

You need VS Code, Node.js with npm, Ollama, and a model downloaded in Ollama. By default, Jambavan expects `qwen3.5:9b` and an Ollama server at `http://localhost:11434`. You can change these in VS Code settings.

1. Clone this repository and open its folder in VS Code.
2. Open **Terminal → New Terminal** and run `npm install`.
3. Make sure Ollama is running and the configured model is available. For example, run `ollama list` in a terminal to check installed models.
4. Press **F5**. VS Code compiles the extension and opens a second window called **Extension Development Host**.
5. In that second window, select the **Private Agent** speech-bubble icon in the Activity Bar.
6. Ask a question. Use `/scan` to update repository notes, or `/edit` followed by a requested change to propose an edit to the active file.

F5 is the development workflow: it opens a temporary test window. The project is not yet packaged as a regular VS Code installation, so this is how I currently try changes while building it.

## What happens when I ask a question

Jambavan gathers a limited set of workspace paths, project instructions, the active file excerpt, optional files I selected, repository notes, and a small amount of recent conversation. It sends that context and my question to the Ollama URL in settings. It then shows the model's response and the context items supplied with the request.

When I ask for a code change in chat, Jambavan should include a concrete code example and explain where it belongs. That answer is guidance only; it does not change the file. To create a proposal and review it in a diff, type `/edit` followed by the requested change while the target file is active. Jambavan first tries a complete-file proposal. If that fails a safety check, it can prepare a focused edit; recognizable SQL index requests are checked against the active `CREATE TABLE` statement and its declared columns, while other focused edits use an exact-line anchor from the model. I can apply or discard the diff.

For a scan, Jambavan finds supported text files, skips ignored folders and likely sensitive files, checks file hashes, and asks Ollama to summarize changed files. It streams each summary and saves it to the index as it completes. The readable notes are regenerated from that index.

For `/edit`, Jambavan asks the model for a complete replacement of the active file and opens a side-by-side diff. The original is unchanged until I choose **Apply proposal**. I review the result and save it myself.

## Privacy and current limits

The default Ollama URL points to the local machine, but the extension uses whatever URL is configured in VS Code settings. Chat context is sent to that endpoint. Chat history and remembered choices are saved locally in VS Code extension storage, not in the repository. Repository notes are saved in the repository itself.

Jambavan filters some sensitive-looking filenames and redacts several common secret formats during scanning. This is a basic precaution, not a complete secret detector. I should review what is included in the context list and avoid putting secrets in prompts or source files.

This is an early prototype. It does not run tests, execute shell commands, monitor GitHub, or fine-tune the model. A repository summary is a navigation aid, not verified truth; check the source before relying on a recommendation.

## Current learning goals

1. Improve how Jambavan finds the most relevant files and notes for a question.
2. Make saved memory easier to inspect, edit, and clear.
3. Add a user-approved test workflow and teach Jambavan how to explain the results.
4. Explore Git-aware change summaries after changes reach the local checkout.

I’ll keep this README and the learning journal updated as the project changes. Suggestions and questions are welcome through GitHub Issues or Discussions.
