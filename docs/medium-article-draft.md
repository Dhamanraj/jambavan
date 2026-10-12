# Jambavan: Building a Local Coding Agent While Learning How VS Code Extensions Work

### What I learned by turning a local Ollama model into a repository-aware coding assistant

I had already written about building [Buddy, my personal AI agent](https://medium.com/towards-artificial-intelligence/buddy-my-personal-ai-agent-3376e4f8efb1), for exploring my financial data. In that project, I spent a lot of time thinking about how an AI system gets the right context, how to make its decisions visible, and where a human should stay in control.

After Buddy, I started asking a different question: could I use those same ideas to build an assistant for software projects?

That question became Jambavan.

Jambavan is an experimental VS Code extension that connects to Ollama and my local Qwen 3.5 9B model. It can chat about the repository I have open, scan files into reusable notes, remember recent conversations and feedback locally, and propose code edits for me to review.

It is still a work in progress. I’m building it to learn how coding assistants fit together—not to claim that I have built an autonomous software engineer.

## The Problem: A Coding Assistant Needs Project Context

A coding question rarely exists on its own. Even a simple request like “add validation here” depends on the project’s structure, naming conventions, existing instructions, and the file currently open in the editor.

I wanted to explore an assistant that could use the repository I was already working in, while keeping the model on my own machine. I already had Ollama installed, so I chose to start with the local `qwen3.5:9b` model rather than build around a hosted API.

I also wanted to learn the mechanics instead of treating the model as a magic box. How does VS Code give an extension access to the active project? How does a chat window talk to extension code? How do I keep a proposed code change reviewable?

Those questions shaped the first version of Jambavan.

## Phase 1: Getting a First Extension Running

I started with a TypeScript VS Code extension and a simple goal: open a chat view from the Activity Bar and send a question to Ollama.

The first development surprise was that **F5 opens a second VS Code window**. That window is called the Extension Development Host. It loads the extension from the project so I can try it while I’m building it. It is not the same as installing the extension into my everyday VS Code setup.

That distinction sounds small, but it explained several early moments where I thought Jambavan had failed to install or its commands had disappeared. I was looking in the wrong window or expecting the debug workflow to behave like a normal extension installation.

## Phase 2: Connecting the Chat to Ollama

The chat view has two parts. A webview draws the messages and input box. The extension host uses VS Code APIs, gathers project context, and sends requests to Ollama. The two parts exchange messages through VS Code’s extension messaging API.

The first version could ask the model a question, but I didn’t want to send the whole repository with every prompt. Instead, Jambavan collects bounded context: a set of file paths, project guidance, a short excerpt from the active file, and any extra files I explicitly select.

After an answer, the chat can show the context items that were included in the request. That gives me a way to inspect what Jambavan supplied to the model. It does not tell me exactly which item the model relied on internally, but it makes the request less of a black box.

The request goes to the Ollama URL configured in VS Code settings. The default is `http://localhost:11434`, but the configured URL matters: if I change it, the prompt goes to that endpoint instead.

## Phase 3: Giving the Agent Notes About a Repository

I wanted Jambavan to build knowledge it could reuse instead of starting from zero every time. The scanner reads supported text files and asks Ollama to create short summaries. It writes those summaries into two places:

- `JAMBAVAN_NOTES.md` is a readable set of notes for a person browsing the repository.
- `.jambavan/scan-index.json` stores file hashes and summaries so Jambavan can tell which files have changed.

When a file changes, the extension queues a scan. It also checks for changes when VS Code starts. Unchanged files are skipped, and a scan saves each completed summary as it goes.

There is an important boundary here: Jambavan scans the files in the workspace on my machine. It does not watch GitHub for pull requests. If a PR is merged online, the changed files become visible to Jambavan after I pull or check out those changes locally.

These notes are a navigation aid, not a substitute for reading the source. A generated summary can be incomplete or wrong, so Jambavan is designed to show the context it used and I still need to verify important claims in the code.

## Phase 4: Keeping Code Changes Reviewable

The `/edit` action asks the model to propose a complete replacement for the active file. Jambavan opens that proposal in a side-by-side diff and waits for me to apply or discard it.

That review step is deliberate. I wanted to learn how to connect an AI suggestion to the editor without letting a generated response silently overwrite my work. Applying a proposal changes the editor buffer; I still review it and save it myself.

This first approach has limits. It works best with smaller files because the model needs to return the complete file. Jambavan does not currently run tests or shell commands after an edit.

## Phase 5: Adding Local Memory and Feedback

I also wanted conversations to survive a VS Code restart. Jambavan saves recent chat messages and feedback in VS Code extension storage, separately from the repository notes.

Under an answer, I can choose **Helpful**, **Not helpful**, or **Remember**. Relevant saved choices can be included in later requests as preferences. This is a simple local memory system: it stores text and looks for keyword overlap with a new question. It does not fine-tune Qwen or change the model’s weights.

Making that distinction matters to me. “Learning” can mean many things. In Jambavan today, it means updating repository notes and using saved feedback as additional prompt context—not training a model or autonomously rewriting its own code.

## The Debugging Lessons

Building the first version was not a straight line from idea to working extension. A few problems taught me more about the system than a quick success would have.

### The command that did not exist

At one point, VS Code reported that the edit command was not found. The root issue was that the extension host had not started and registered its commands. I learned to distinguish a command implementation problem from a development-host startup problem, and to check the debug window and its output before changing code.

### Ollama answered the health check, but the scan still timed out

Ollama could return a successful response to a basic server check while a long model request still took too long. A reachable HTTP server does not mean that a model has finished generating an answer.

I changed repository summaries to stream from Ollama and save after each file. That way, completed summaries remain available if a later request fails, and the next scan can skip unchanged work.

### Generated notes can sound more certain than they are

The notes are written by a model, so they can omit details or make mistakes. Showing source context and keeping the original files available gives me a way to check them. I’m treating the notes as a map, not as ground truth.

## What Jambavan Does—and Does Not—Do Yet

Today, Jambavan can chat about bounded workspace context, scan supported files into notes, save recent chats and user feedback locally, show the context sent with an answer, and prepare an edit proposal for review.

It does not run tests, execute terminal commands, connect to GitHub, or fine-tune the model. Its filename filters and secret redaction are basic precautions, not a guarantee that sensitive data will never be included. With the default settings, requests go to Ollama on the local machine; I should verify the configured endpoint before using it.

I’m writing those limits down because this is a learning project. A clear boundary is more useful than a feature claim that sounds impressive but isn’t true yet.

## What I Want to Build Next

My next steps are to improve how Jambavan chooses relevant files and notes, make saved memory easier to inspect and clear, and add a user-approved test workflow. After that, I want to explore summaries of local Git changes and learn what it would take to integrate with a remote pull-request workflow responsibly.

The larger idea is still to build a private coding assistant that adapts to the projects I work on. The practical way I’m getting there is by adding one small capability at a time, trying it in VS Code, and recording what I learn.

## Try the Project

The source code is on [GitHub](https://github.com/Dhamanraj/jambavan). To run the current development version, you need VS Code, Node.js with npm, Ollama, and the `qwen3.5:9b` model.

1. Clone the repository and open it in VS Code.
2. Run `npm install` in the integrated terminal.
3. Make sure Ollama is running and `qwen3.5:9b` is available.
4. Press **F5** to open the Extension Development Host.
5. Select the **Private Agent** icon and try asking about the open project.

This is a development setup, not a packaged Marketplace extension. I’m still learning how to turn the prototype into something I can install and use across VS Code workspaces.

---

Dhaman  
Data Engineer | Aviation Enthusiast | Hobbyist Photographer
