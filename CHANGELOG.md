# Changelog

## 0.2.0

- Saved chats for each project, with a searchable history panel (open, rename, delete). The last chat reopens on restart.
- Modes: Ask before edits, Edit automatically and Plan mode (read-only, with an **Execute plan** button). Shift+Tab cycles between them.
- `@` file and folder mentions with autocomplete. Slash commands: `/new`, `/clear`, `/compact`, `/init`, `/memory`, `/history`, `/model`, `/help`.
- An editor-context chip, a context-usage meter, and display of thinking-model reasoning.
- A live task list (`todo_write` tool).
- Message actions: copy, edit and retry, plus copy and insert for code blocks. Messages sent while the agent works are queued, and earlier messages can be recalled with the arrow keys.

## 0.1.0

- First release.
- Supports Ollama (download, delete and select models from VS Code) and OpenAI-compatible local servers (LM Studio, llama.cpp, vLLM, LocalAI).
- Agent tools: read, list, exact search, semantic search, edit with diff review, create files, run commands with approval, and project memory.
- Persistent project memory in `.mgbot/memory.md`, plus an incremental semantic code index in `.mgbot/index/`.
- Text-based tool calling for models without native tool support.
