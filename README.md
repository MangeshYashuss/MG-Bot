# MG Bot — local AI coding agent

MG Bot is a coding agent that runs open-weight models **on your own machine**. It reads, searches, edits and tests your codebase from a chat panel in VS Code, and it **keeps a long-term memory of each project**, so new sessions start with what earlier sessions learned.

Nothing leaves your computer unless you choose a cloud model in your runtime.

## Features

- **Download and manage models in VS Code.** Browse a curated catalog of coding and embedding models, download with progress, delete, and choose which model to use. Any model from the Ollama library or Hugging Face GGUF can be downloaded by name.
- **Choose your runtime.** Works with [Ollama](https://ollama.com) out of the box, or any OpenAI-compatible local server (LM Studio, llama.cpp `llama-server`, vLLM, LocalAI, Jan).
- **A full agent with approvals.** The model can:

  | Tool | What it does | Needs approval |
  |---|---|---|
  | `read_file`, `list_dir` | Read code and browse folders | No |
  | `search_code` | Exact or regex search (uses VS Code's bundled ripgrep) | No |
  | `semantic_search` | Find code by meaning through the local index | No |
  | `edit_file`, `create_file` | Change files after you review a diff | Yes (configurable) |
  | `run_command` | Run tests, builds or git, with output shown in an "MG Bot" terminal | Yes, unless allow-listed |
  | `remember`, `recall` | Write and read the project memory | No |
  | `todo_write` | Keep a task list that you can watch in the chat | No |

- **Chat history for each project.** Every chat is saved automatically. Open the history list (☰ or **MG Bot: Show Chat History**) to search, reopen, rename or delete earlier chats. Each workspace has its own history, kept in VS Code's storage rather than in your repository. The last chat reopens when you restart VS Code.
- **Memory that persists.**
  - **Project memory** (`.mgbot/memory.md`): the agent records architecture facts, conventions, decisions, your preferences and open TODOs. The file is loaded into every session. You can edit it and commit it to share with your team.
  - **Code index** (`.mgbot/index/`): an embedding index of your workspace. It updates incrementally when files change and loads instantly when you reopen the project. Relevant snippets are added to the model's context automatically. The index is ignored by git.
- **Works with small models.** If a model has no native tool calling, MG Bot switches to a text-based tool protocol. Long conversations are trimmed to fit the model's context window, and the oldest tool output is trimmed first.

## Getting started

1. Install [Ollama](https://ollama.com/download) and make sure it is running. To use another runtime, click **Select Model Runtime** in the Models view.
2. Open the **MG Bot** view in the activity bar.
3. In **Models → Download**, download a chat model (for example `qwen2.5-coder:7b`) and an embedding model (`nomic-embed-text`). The first of each kind is selected automatically.
4. Open a project folder and ask something in the chat, for example:
   - "Give me an overview of this repo and remember the key architecture."
   - "Add input validation to the signup handler."
   - "Run the tests and fix whatever fails."

You can also right-click a selection and choose **MG Bot: Explain Selection** or **MG Bot: Refactor Selection**.

## Using the chat

| Feature | How |
|---|---|
| **Modes** | Click the mode button or press **Shift+Tab** to cycle. *Ask before edits* shows a diff for approval. *Edit automatically* applies file changes without review (commands still ask). *Plan mode* is read-only: the agent investigates and writes a plan, then **Execute plan** carries it out. |
| **Attach files** | Type `@` and pick a file or folder. Its contents are sent with your message. |
| **Editor context** | The chip above the input shows the active file and selection, which are included as context. Click the chip to exclude them. |
| **Slash commands** | `/new`, `/clear`, `/compact` (summarize to free context), `/init` (study the project and save it to memory), `/memory`, `/history`, `/model`, `/mcp`, `/help`, plus your own skills (below) |
| **Context meter** | The percentage in the header shows how full the model's context window is. Use `/compact` when it gets high. |
| **Thinking** | Reasoning from thinking models (Qwen3, DeepSeek-R1, gpt-oss…) appears in a collapsible *Thought process* block. |
| **Task list** | For multi-step work the agent keeps a live checklist above the input. |
| **Message actions** | Hover a message to copy it. On your own messages, **Edit** or **Retry** replays from that point; file changes already made are kept. Code blocks have **Copy** and **Insert** (at the editor cursor) buttons. |
| **Queue** | Send messages while the agent is working; they run in order when it finishes. |
| **Keyboard** | Enter sends · Shift+Enter adds a new line · ↑/↓ recalls earlier messages · Esc stops the agent |

### Skills (custom slash commands)

A skill is a markdown file whose contents are sent to the agent when you type `/<file name>`. Run **MG Bot: New Skill** or create the file yourself:

- `.mgbot/skills/<name>.md` in the project (commit it to share it with your team)
- `~/.mgbot/skills/<name>.md` for every project

```markdown
---
description: Review the current changes
---
Run `git diff`, review it for bugs and missing tests, and list problems by severity.
Focus on: $ARGUMENTS
```

`$ARGUMENTS` is replaced by the text typed after the command. Without the placeholder, that text is added at the end. Skills appear in the `/` menu as soon as you save the file. Built-in commands keep their names, and a project skill wins over a global skill with the same name.

### MCP servers

MG Bot can use tools from [Model Context Protocol](https://modelcontextprotocol.io) servers. Add them to `mgbot.mcpServers` (**MG Bot: Configure MCP Servers**), using the same format as other MCP clients:

```json
"mgbot.mcpServers": {
  "fetch": { "command": "uvx", "args": ["mcp-server-fetch"] },
  "github": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "…" },
    "autoApprove": ["search_repositories"]
  },
  "docs": { "url": "http://localhost:3000/mcp" }
}
```

- Servers start the first time the agent runs, not when VS Code starts. They restart when you change the setting.
- Every MCP tool call asks for approval, unless the server marks the tool read-only or you list it in `autoApprove` (`true` approves all of that server's tools).
- In plan mode, only read-only MCP tools are offered.
- Type `/mcp` to see which servers are connected and which tools they provide.
- Small local models get less reliable as more tools are added. Connect only the servers you need.

### Choosing a model

| Your machine | Suggested chat model |
|---|---|
| 8 GB RAM, no GPU | `qwen2.5-coder:1.5b` (fast; basic agent ability) |
| 16 GB RAM or 8 GB GPU | `qwen2.5-coder:7b` or `llama3.1:8b` |
| 32 GB RAM or 16–24 GB GPU | `qwen2.5-coder:14b`, `devstral:24b`, `qwen3-coder:30b` |

Larger models follow instructions and use tools much more reliably. Very small models may struggle with multi-step edits.

## Settings

| Setting | Default | Description |
|---|---|---|
| `mgbot.provider` | `ollama` | `ollama` or `openai-compatible` |
| `mgbot.endpoint` | (runtime default) | Server URL |
| `mgbot.chatModel` | | Model for chat and agent work |
| `mgbot.embeddingModel` | | Model for the code index. Leave empty to turn the index off |
| `mgbot.contextSize` | `16384` | Context window to request, capped at the model's maximum |
| `mgbot.maxSteps` | `25` | Maximum tool steps per request |
| `mgbot.autoApproveEdits` | `false` | Start in *Edit automatically* mode (change modes in the chat with Shift+Tab) |
| `mgbot.commandAllowList` | `[]` | Command prefixes that run without asking, e.g. `npm test`. Chained commands (`&&`, `;`, pipes) always ask |
| `mgbot.commandTimeoutSeconds` | `120` | Time limit for agent commands |
| `mgbot.index.enabled` | `true` | Turn the code index on or off |
| `mgbot.index.exclude` | `[]` | Extra gitignore-style patterns to skip |
| `mgbot.index.maxFileSizeKB` | `256` | Skip larger files when indexing |
| `mgbot.mcpServers` | `{}` | MCP servers whose tools the agent can use (see above) |

## Privacy and safety

- MG Bot only talks to the runtime URL you configure. It has no telemetry.
- Ollama "cloud" models (shown with a cloud icon) run on remote servers. Use a local model to keep code on your machine.
- File access is limited to the open workspace folders. Writes to `.git/` and the index are blocked.
- Every edit and command needs your approval unless you change the settings above.
- MCP servers run as local processes with your permissions. Only add servers you trust. In a folder you haven't trusted (VS Code Workspace Trust), `mgbot.mcpServers` and `mgbot.commandAllowList` from that folder's settings are ignored.
- The agent is told never to store secrets in project memory. Review `.mgbot/memory.md` before committing it.

## Development

```bash
npm install
npm run build      # bundles dist/extension.js and dist/webview.js
npm test           # unit tests (providers against a mock server, memory, index, edits, guards)
npm run package    # builds a .vsix
```

Press F5 in VS Code with this folder open to launch an Extension Development Host.
