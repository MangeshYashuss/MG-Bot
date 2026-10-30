import type { SlashCommand } from '../chat/text';

export interface ChatHtmlOptions {
  nonce: string;
  cspSource: string;
  scriptUri: string;
  styleUri: string;
  codiconUri: string;
  commands: SlashCommand[];
}

/** Markup for the chat webview (kept free of the vscode API so it can be tested in jsdom). */
export function chatHtml(o: ChatHtmlOptions): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${o.cspSource}; font-src ${o.cspSource}; script-src 'nonce-${o.nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${o.codiconUri}" rel="stylesheet">
<link href="${o.styleUri}" rel="stylesheet">
<title>MG Bot</title>
</head>
<body>
<header class="toolbar">
  <button type="button" id="historyBtn" class="icon-btn" title="Chat history" aria-label="Chat history"><i class="codicon codicon-history"></i></button>
  <span id="title" class="chat-title" title="Double-click to rename">New chat</span>
  <span id="usage" class="usage" hidden></span>
  <button type="button" id="newBtn" class="icon-btn" title="New chat" aria-label="New chat"><i class="codicon codicon-add"></i></button>
</header>

<section id="history" class="history" hidden>
  <div class="history-head">
    <input id="historySearch" type="search" placeholder="Search chats…" aria-label="Search chats">
    <button type="button" id="historyClose" class="icon-btn" title="Close" aria-label="Close"><i class="codicon codicon-close"></i></button>
  </div>
  <ul id="historyList"></ul>
</section>

<main id="log" aria-live="polite"></main>

<section id="todos" class="todos" hidden></section>

<form id="composer">
  <div id="queue" class="queue" hidden></div>
  <div class="context-row">
    <button type="button" id="editorChip" class="chip" hidden title="Include the active file / selection as context"></button>
  </div>
  <div class="box">
    <div class="input-wrap">
      <ul id="suggest" class="suggest" hidden role="listbox"></ul>
      <textarea id="input" rows="3" placeholder="Ask MG Bot…  @ to add files, / for commands"></textarea>
    </div>
    <div class="actions">
      <button type="button" id="modeBtn" class="mode" title="Switch mode (Shift+Tab)"></button>
      <select id="model" title="Chat model"></select>
      <span id="status" class="status" title="Runtime status"></span>
      <span class="spacer"></span>
      <button type="button" id="stop" class="round secondary" hidden title="Stop (Esc)" aria-label="Stop"><i class="codicon codicon-debug-stop"></i></button>
      <button type="submit" id="send" class="round" title="Send (Enter)" aria-label="Send"><i class="codicon codicon-send"></i></button>
    </div>
  </div>
</form>
<script nonce="${o.nonce}">window.MGBOT_COMMANDS = ${JSON.stringify(o.commands).replace(/</g, '\\u003c')};</script>
<script nonce="${o.nonce}" src="${o.scriptUri}"></script>
</body>
</html>`;
}
