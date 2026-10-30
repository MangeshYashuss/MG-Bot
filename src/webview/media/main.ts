// Chat webview UI. Runs in the browser sandbox; talks to the extension through postMessage.
declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
declare global {
  interface Window {
    MGBOT_COMMANDS: { name: string; description: string }[];
  }
}

type Mode = 'ask' | 'auto' | 'plan';
type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed' };

const vscode = acquireVsCodeApi();
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const log = $('log');
const input = $<HTMLTextAreaElement>('input');
const form = $<HTMLFormElement>('composer');
const sendBtn = $<HTMLButtonElement>('send');
const stopBtn = $<HTMLButtonElement>('stop');
const modelSel = $<HTMLSelectElement>('model');
const statusEl = $('status');
const modeBtn = $<HTMLButtonElement>('modeBtn');
const titleEl = $('title');
const usageEl = $('usage');
const editorChip = $<HTMLButtonElement>('editorChip');
const suggestEl = $<HTMLUListElement>('suggest');
const queueEl = $('queue');
const todosEl = $('todos');
const historyEl = $('history');
const historyList = $<HTMLUListElement>('historyList');
const historySearch = $<HTMLInputElement>('historySearch');

const MODES: Record<Mode, { label: string; hint: string }> = {
  ask: { label: '✋ Ask before edits', hint: 'MG Bot shows a diff and waits for your approval before changing files.' },
  auto: { label: '⚡ Edit automatically', hint: 'File changes are applied without review. Commands still ask.' },
  plan: { label: '🗺 Plan mode', hint: 'Read-only: MG Bot investigates and proposes a plan without changing anything.' },
};
const MODE_ORDER: Mode[] = ['ask', 'auto', 'plan'];
const TOOL_ICONS: Record<string, string> = {
  read_file: '📄', list_dir: '📁', search_code: '🔎', semantic_search: '🧭', edit_file: '✏️',
  create_file: '🆕', run_command: '▶️', remember: '🧠', recall: '🧠', todo_write: '☑️',
};

const ui = {
  mode: 'ask' as Mode,
  includeEditor: true,
  busy: false,
  chatId: '',
  editor: null as null | { path: string; selection: null | { start: number; end: number } },
  queue: [] as string[],
  sentHistory: [] as string[],
  historyPos: -1,
  draft: '',
  chats: [] as { id: string; title: string; when: string; messageCount: number; model?: string }[],
  currentChatId: '',
};

let current: { el: HTMLElement; body: HTMLElement; thinkingEl?: HTMLDetailsElement; raw: string; thinking: string } | undefined;
const tools = new Map<string, HTMLDetailsElement>();
const approvals = new Map<string, HTMLElement>();
const codeBlocks: string[] = [];

// ---- Helpers ---------------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, title: string, onClick: () => void, cls = 'link-btn'): HTMLButtonElement {
  const b = el('button', cls, label);
  b.type = 'button';
  b.title = title;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function splitThinking(text: string): { content: string; thinking: string } {
  const parts: string[] = [];
  const content = text.replace(/<think>([\s\S]*?)(<\/think>|$)/g, (_m, inner: string) => {
    parts.push(inner.trim());
    return '';
  });
  return { content, thinking: parts.join('\n\n') };
}

/** Small, safe markdown renderer: everything is escaped first, then a few constructs are re-enabled. */
function renderMarkdown(src: string): string {
  // Hide text-protocol tool calls; they are shown as tool cards instead.
  src = src.replace(/```(?:tool|tool_call)\s*\n[\s\S]*?(```|$)/g, '');
  const blocks: string[] = [];
  src = src.replace(/```([\w+#.-]*)[^\n]*\n([\s\S]*?)(```|$)/g, (_m, lang: string, code: string) => {
    const id = codeBlocks.push(code.replace(/\n$/, '')) - 1;
    blocks.push(
      `<div class="code"><div class="code-bar"><span class="lang">${escapeHtml(lang || 'text')}</span>` +
        `<button type="button" class="link-btn" data-copy-code="${id}" title="Copy code">Copy</button>` +
        `<button type="button" class="link-btn" data-insert-code="${id}" title="Insert at cursor in the editor">Insert</button></div>` +
        `<pre><code>${escapeHtml(codeBlocks[id])}</code></pre></div>`,
    );
    return `\u0000${blocks.length - 1}\u0000`;
  });
  const inline = (s: string) =>
    escapeHtml(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<span class="link" title="$2">$1</span>');

  const out: string[] = [];
  let list: 'ul' | 'ol' | undefined;
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = undefined;
  };
  for (const line of src.split('\n')) {
    const block = /^\u0000(\d+)\u0000$/.exec(line.trim());
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (block) {
      closeList();
      out.push(blocks[Number(block[1])]);
    } else if (heading) {
      closeList();
      out.push(`<h${heading[1].length + 2}>${inline(heading[2])}</h${heading[1].length + 2}>`);
    } else if (bullet || numbered) {
      const kind = bullet ? 'ul' : 'ol';
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline((bullet ?? numbered)![1])}</li>`);
    } else if (!line.trim()) {
      closeList();
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return out.join('').replace(/\u0000(\d+)\u0000/g, (_m, i) => blocks[Number(i)]);
}

function nearBottom(): boolean {
  return log.scrollHeight - log.scrollTop - log.clientHeight < 80;
}

function scroll(force = false): void {
  if (force || nearBottom()) log.scrollTop = log.scrollHeight;
}

// ---- Conversation rendering ------------------------------------------------------------------

function addUser(text: string, tIndex: number): void {
  clearWelcome();
  removePlanActions();
  const wrap = el('div', 'msg user');
  const bubble = el('div', 'bubble');
  // Highlight @mentions without using innerHTML on user text.
  for (const part of text.split(/((?:^|\s)@[\w./\\-]*[\w/])/)) {
    if (/^\s?@/.test(part)) {
      if (part.startsWith(' ') || part.startsWith('\n')) bubble.append(part[0]);
      bubble.append(el('span', 'mention', part.trim()));
    } else if (part) bubble.append(part);
  }
  const actions = el('div', 'msg-actions');
  actions.append(
    button('Edit', 'Edit this message (removes it and everything after it from the chat)', () => vscode.postMessage({ type: 'editFrom', index: tIndex })),
    button('Retry', 'Send this message again (removes the replies after it)', () => vscode.postMessage({ type: 'retryFrom', index: tIndex })),
    button('Copy', 'Copy message', () => vscode.postMessage({ type: 'copy', text })),
  );
  wrap.append(bubble, actions);
  log.appendChild(wrap);
  if (text && ui.sentHistory[ui.sentHistory.length - 1] !== text) ui.sentHistory.push(text);
  scroll(true);
}

function startAssistant(): void {
  if (current) return;
  const wrap = el('div', 'msg assistant');
  const body = el('div', 'body');
  body.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  wrap.append(body);
  log.appendChild(wrap);
  current = { el: wrap, body, raw: '', thinking: '' };
  scroll();
}

function showThinking(text: string, streaming: boolean): void {
  if (!current || !text.trim()) return;
  if (!current.thinkingEl) {
    current.thinkingEl = el('details', 'thinking');
    current.thinkingEl.append(el('summary', '', 'Thinking…'), el('div', 'thinking-body'));
    current.el.insertBefore(current.thinkingEl, current.body);
  }
  current.thinkingEl.open = streaming;
  current.thinkingEl.querySelector('summary')!.textContent = streaming ? 'Thinking…' : 'Thought process';
  current.thinkingEl.querySelector('.thinking-body')!.textContent = text.trim();
}

function updateStreaming(): void {
  if (!current) return;
  const { content, thinking } = splitThinking(current.raw);
  showThinking([current.thinking, thinking].filter(Boolean).join('\n\n'), true);
  const html = renderMarkdown(content);
  current.body.innerHTML = html || '<span class="typing"><i></i><i></i><i></i></span>';
  scroll();
}

function endAssistant(text: string, thinking: string): void {
  if (!current) startAssistant();
  const c = current!;
  const split = splitThinking(text || c.raw);
  const allThinking = [thinking || c.thinking, split.thinking].filter(Boolean).join('\n\n');
  showThinking(allThinking, false);
  if (split.content.trim()) {
    c.body.innerHTML = renderMarkdown(split.content);
    const actions = el('div', 'msg-actions');
    actions.append(button('Copy', 'Copy response', () => vscode.postMessage({ type: 'copy', text: split.content })));
    c.el.append(actions);
  } else if (allThinking) {
    c.body.remove();
  } else {
    c.el.remove();
  }
  current = undefined;
  scroll();
}

function addTool(id: string, name: string, label: string): void {
  if (current && !current.raw.trim() && !current.thinking) {
    current.el.remove();
    current = undefined;
  }
  const card = el('details', 'tool running');
  const summary = el('summary');
  summary.append(el('span', 'icon', TOOL_ICONS[name] ?? '🔧'), el('span', 'name', name), el('span', 'label', label));
  card.append(summary, el('pre', 'result', 'Running…'));
  log.appendChild(card);
  tools.set(id, card);
  scroll();
}

function endTool(id: string, ok: boolean, result: string): void {
  const card = tools.get(id);
  if (!card) return;
  card.classList.remove('running');
  card.classList.add(ok ? 'ok' : 'failed');
  card.querySelector('.result')!.textContent = result;
}

function addApproval(id: string, kind: string, title: string, detail: string): void {
  const card = el('div', `approval ${kind}`);
  card.append(el('div', 'title', title));
  if (kind !== 'command') card.append(el('div', 'hint', 'Review the diff in the editor.'));
  card.append(el('pre', 'detail', detail));
  const row = el('div', 'buttons');
  row.append(
    button(kind === 'command' ? 'Run' : 'Apply', 'Approve', () => vscode.postMessage({ type: 'approve', id, approved: true }), ''),
    button('Reject', 'Reject', () => vscode.postMessage({ type: 'approve', id, approved: false }), 'secondary'),
  );
  card.append(row);
  log.appendChild(card);
  approvals.set(id, card);
  scroll(true);
}

function endApproval(id: string, approved: boolean): void {
  const card = approvals.get(id);
  if (!card) return;
  card.classList.add('done');
  card.querySelector('.buttons')?.replaceWith(el('div', approved ? 'verdict ok' : 'verdict failed', approved ? 'Approved' : 'Rejected'));
}

function addNotice(text: string, level: string): void {
  log.appendChild(el('div', `notice ${level}`, text));
  scroll();
}

function renderTodos(todos: Todo[]): void {
  todosEl.hidden = !todos.length;
  todosEl.innerHTML = '';
  if (!todos.length) return;
  const done = todos.filter((t) => t.status === 'completed').length;
  const details = el('details');
  details.open = done < todos.length;
  details.append(el('summary', '', `Tasks ${done}/${todos.length}`));
  const list = el('ul');
  const icon = { pending: '○', in_progress: '◐', completed: '●' };
  for (const t of todos) {
    const li = el('li', t.status);
    li.append(el('span', 'todo-icon', icon[t.status]), el('span', '', t.content));
    list.append(li);
  }
  details.append(list);
  todosEl.append(details);
}

function renderUsage(usage: { used: number; max: number } | null): void {
  if (!usage || !usage.max) {
    usageEl.hidden = true;
    return;
  }
  const pct = Math.min(100, Math.round((usage.used / usage.max) * 100));
  usageEl.hidden = false;
  usageEl.textContent = `${pct}%`;
  usageEl.className = `usage ${pct >= 85 ? 'high' : pct >= 60 ? 'mid' : ''}`;
  usageEl.title = `Context used: ~${usage.used.toLocaleString()} of ${usage.max.toLocaleString()} tokens.${pct >= 60 ? ' Type /compact to summarize and free space.' : ''}`;
}

function showPlanActions(): void {
  removePlanActions();
  const last = log.lastElementChild;
  if (ui.mode !== 'plan' || !last?.classList.contains('assistant')) return;
  const row = el('div', 'plan-actions');
  row.append(
    button('Execute plan', 'Switch to "Ask before edits" and carry out this plan', () => vscode.postMessage({ type: 'executePlan' }), ''),
    button('Keep planning', 'Refine the plan', () => input.focus(), 'secondary'),
  );
  log.appendChild(row);
  scroll();
}

function removePlanActions(): void {
  log.querySelectorAll('.plan-actions').forEach((n) => n.remove());
}

function showWelcome(healthy: boolean, hasModel: boolean): void {
  const w = el('div', 'welcome');
  w.append(el('h2', '', 'MG Bot'), el('p', '', 'A coding agent that runs on your machine and remembers your project.'));
  const steps = el('ol');
  steps.append(
    el('li', healthy ? 'done' : '', 'Start a local runtime (Ollama, LM Studio or llama.cpp).'),
    el('li', hasModel ? 'done' : '', 'Pick or download a chat model (and an embedding model for code search) in the Models view.'),
    el('li', '', 'Ask anything. Type @ to attach files, / for commands, Shift+Tab to change mode.'),
  );
  w.append(steps);
  const tips = el('div', 'welcome-actions');
  tips.append(
    button('/init — learn this project', 'Study the project and save it to memory', () => vscode.postMessage({ type: 'send', text: '/init' }), 'secondary'),
    button('Chat history', 'Previous chats in this project', () => openHistory(), 'secondary'),
  );
  w.append(tips);
  log.appendChild(w);
}

function clearWelcome(): void {
  log.querySelector('.welcome')?.remove();
}

function resetLog(): void {
  log.innerHTML = '';
  tools.clear();
  approvals.clear();
  codeBlocks.length = 0;
  current = undefined;
}

// ---- State -----------------------------------------------------------------------------------

let lastState: any;

function setState(s: any): void {
  lastState = s;
  ui.mode = s.mode;
  ui.includeEditor = s.includeEditor;
  ui.chatId = s.chatId;
  titleEl.textContent = s.title;
  titleEl.title = `${s.title} — double-click to rename`;
  modeBtn.textContent = MODES[ui.mode].label;
  modeBtn.title = `${MODES[ui.mode].hint} (Shift+Tab to switch)`;
  modeBtn.className = `mode ${ui.mode}`;
  statusEl.className = `status ${s.healthy ? 'up' : 'down'}`;
  statusEl.title = s.healthy ? `${s.runtime} is running` : `${s.runtime} is not reachable`;

  modelSel.innerHTML = '';
  if (!s.models.length) {
    const opt = el('option', '', s.healthy ? 'No models — open Models view' : 'Runtime offline');
    opt.value = '';
    modelSel.append(opt);
  }
  for (const m of s.models) {
    const opt = el('option', '', m.remote ? `${m.name} (cloud)` : m.name);
    opt.value = m.name;
    opt.selected = m.name === s.chatModel;
    modelSel.append(opt);
  }
  if (s.chatModel && !s.models.some((m: any) => m.name === s.chatModel)) {
    const opt = el('option', '', `${s.chatModel} (not installed)`);
    opt.value = s.chatModel;
    opt.selected = true;
    modelSel.prepend(opt);
  }
  renderEditorChip();
  if (!log.children.length) showWelcome(s.healthy, !!s.chatModel);
  else if (s.healthy) log.querySelector('.welcome li:first-child')?.classList.add('done');
}

function setBusy(busy: boolean): void {
  const wasBusy = ui.busy;
  ui.busy = busy;
  stopBtn.hidden = !busy;
  sendBtn.textContent = busy ? 'Queue' : 'Send';
  sendBtn.title = busy ? 'Queue this message to send when MG Bot finishes' : 'Send (Enter)';
  if (wasBusy && !busy) {
    if (ui.queue.length) {
      const next = ui.queue.shift()!;
      renderQueue();
      vscode.postMessage({ type: 'send', text: next });
    } else {
      showPlanActions();
    }
  }
}

function renderEditorChip(): void {
  const e = ui.editor;
  editorChip.hidden = !e;
  if (!e) return;
  const name = e.path.split('/').pop();
  editorChip.textContent = `${ui.includeEditor ? '👁' : '⊘'} ${name}${e.selection ? `:${e.selection.start}-${e.selection.end}` : ''}`;
  editorChip.title = `${e.path}${e.selection ? ` (lines ${e.selection.start}-${e.selection.end} selected)` : ''}\n${
    ui.includeEditor ? 'Included as context — click to exclude' : 'Not included — click to include'
  }`;
  editorChip.classList.toggle('off', !ui.includeEditor);
}

function renderQueue(): void {
  queueEl.hidden = !ui.queue.length;
  queueEl.innerHTML = '';
  ui.queue.forEach((text, i) => {
    const chip = el('div', 'queued');
    chip.append(el('span', '', `Queued: ${text.length > 60 ? text.slice(0, 57) + '…' : text}`));
    chip.append(button('✕', 'Remove from queue', () => {
      ui.queue.splice(i, 1);
      renderQueue();
    }));
    queueEl.append(chip);
  });
}

// ---- History panel ---------------------------------------------------------------------------

function openHistory(): void {
  historyEl.hidden = false;
  historySearch.value = '';
  historyList.innerHTML = '<li class="empty">Loading…</li>';
  vscode.postMessage({ type: 'listChats' });
  historySearch.focus();
}

function closeHistory(): void {
  historyEl.hidden = true;
}

function renderHistory(): void {
  const q = historySearch.value.trim().toLowerCase();
  const items = ui.chats.filter((c) => !q || c.title.toLowerCase().includes(q));
  historyList.innerHTML = '';
  if (!items.length) {
    historyList.append(el('li', 'empty', ui.chats.length ? 'No chats match your search.' : 'No saved chats in this project yet.'));
    return;
  }
  for (const c of items) {
    const li = el('li', c.id === ui.currentChatId ? 'current' : '');
    li.tabIndex = 0;
    const main = el('div', 'chat-main');
    main.append(el('div', 'chat-name', c.title), el('div', 'chat-meta', `${c.when} · ${c.messageCount} message${c.messageCount === 1 ? '' : 's'}${c.model ? ` · ${c.model}` : ''}`));
    const actions = el('div', 'chat-actions');
    actions.append(
      button('✎', 'Rename', () => startRename(main, c.id, c.title)),
      button('🗑', 'Delete', function (this: void) {
        const b = actions.querySelector<HTMLButtonElement>('[data-del]')!;
        if (b.dataset.armed) {
          vscode.postMessage({ type: 'deleteChat', id: c.id });
        } else {
          b.dataset.armed = '1';
          b.textContent = 'Delete?';
          b.classList.add('danger');
          setTimeout(() => {
            delete b.dataset.armed;
            b.textContent = '🗑';
            b.classList.remove('danger');
          }, 3000);
        }
      }),
    );
    actions.lastElementChild!.setAttribute('data-del', '');
    li.append(main, actions);
    const open = () => {
      vscode.postMessage({ type: 'openChat', id: c.id });
      closeHistory();
    };
    li.addEventListener('click', open);
    li.addEventListener('keydown', (e) => e.key === 'Enter' && open());
    historyList.append(li);
  }
}

function startRename(container: HTMLElement, id: string, title: string): void {
  const field = el('input', 'rename');
  field.value = title;
  let finished = false;
  const finish = (save: boolean) => {
    if (finished) return;
    finished = true;
    if (save && field.value.trim() && field.value.trim() !== title) vscode.postMessage({ type: 'renameChat', id, title: field.value.trim() });
    else renderHistory();
  };
  field.addEventListener('click', (e) => e.stopPropagation());
  field.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  field.addEventListener('blur', () => finish(true));
  container.replaceChildren(field);
  field.select();
}

// ---- Suggestions (@ files and / commands) ---------------------------------------------------

const suggest = {
  kind: '' as '' | 'mention' | 'slash',
  items: [] as { value: string; label: string; detail?: string }[],
  active: 0,
  /** Start offset of the token being completed. */
  start: 0,
  query: '',
};

function updateSuggestions(): void {
  const caret = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, caret);
  const slash = /^\/(\w*)$/.exec(before);
  if (slash) {
    const q = slash[1].toLowerCase();
    suggest.kind = 'slash';
    suggest.start = 0;
    suggest.items = window.MGBOT_COMMANDS.filter((c) => c.name.startsWith(q)).map((c) => ({ value: `/${c.name}`, label: `/${c.name}`, detail: c.description }));
    return renderSuggestions();
  }
  const mention = /(^|\s)@([\w./\\-]*)$/.exec(before);
  if (mention) {
    suggest.kind = 'mention';
    suggest.start = caret - mention[2].length - 1;
    suggest.query = mention[2];
    vscode.postMessage({ type: 'mentionQuery', query: mention[2] });
    return;
  }
  hideSuggestions();
}

function renderSuggestions(): void {
  if (!suggest.items.length) return hideSuggestions();
  suggest.active = Math.min(suggest.active, suggest.items.length - 1);
  suggestEl.innerHTML = '';
  suggest.items.forEach((item, i) => {
    const li = el('li', i === suggest.active ? 'active' : '');
    li.setAttribute('role', 'option');
    li.append(el('span', 'value', item.label));
    if (item.detail) li.append(el('span', 'detail', item.detail));
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      suggest.active = i;
      acceptSuggestion();
    });
    suggestEl.append(li);
  });
  suggestEl.hidden = false;
  suggestEl.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
}

function hideSuggestions(): void {
  suggest.kind = '';
  suggest.items = [];
  suggest.active = 0;
  suggestEl.hidden = true;
}

function acceptSuggestion(): void {
  const item = suggest.items[suggest.active];
  if (!item) return;
  const caret = input.selectionStart ?? input.value.length;
  const insert = suggest.kind === 'mention' ? `@${item.value}${item.value.endsWith('/') ? '' : ' '}` : `${item.value} `;
  input.value = input.value.slice(0, suggest.start) + insert + input.value.slice(caret);
  const pos = suggest.start + insert.length;
  input.setSelectionRange(pos, pos);
  hideSuggestions();
  input.focus();
  // Keep completing inside a folder.
  if (insert.endsWith('/')) updateSuggestions();
}

// ---- Messages from the extension -------------------------------------------------------------

function handle(msg: any): void {
  switch (msg.type) {
    case 'state': return setState(msg);
    case 'user': return addUser(msg.text, msg.tIndex);
    case 'assistantStart': return startAssistant();
    case 'token':
      if (!current) startAssistant();
      current!.raw += msg.text;
      return updateStreaming();
    case 'thinking':
      if (!current) startAssistant();
      current!.thinking += msg.text;
      return updateStreaming();
    case 'assistantEnd': return endAssistant(msg.text ?? '', msg.thinking ?? '');
    case 'toolStart': return addTool(msg.id, msg.name, msg.label);
    case 'toolEnd': return endTool(msg.id, msg.ok, msg.result);
    case 'approval': return addApproval(msg.id, msg.kind, msg.title, msg.detail);
    case 'approvalDone': return endApproval(msg.id, msg.approved);
    case 'notice': return addNotice(msg.text, msg.level);
    case 'busy': return setBusy(msg.value);
    case 'todos': return renderTodos(msg.todos);
    case 'usage': return renderUsage(msg);
    case 'editor':
      ui.editor = msg.path ? { path: msg.path, selection: msg.selection } : null;
      return renderEditorChip();
    case 'fillInput':
      input.value = msg.text;
      input.focus();
      return;
    case 'showHistory': return openHistory();
    case 'chatList':
      ui.chats = msg.items;
      ui.currentChatId = msg.currentId;
      return renderHistory();
    case 'mentionResults':
      if (suggest.kind !== 'mention' || msg.query !== suggest.query) return;
      suggest.items = msg.items.map((p: string) => ({ value: p, label: p.split('/').filter(Boolean).pop() + (p.endsWith('/') ? '/' : ''), detail: p }));
      return renderSuggestions();
    case 'replay':
      resetLog();
      ui.sentHistory = [];
      for (const item of msg.items) handle(item);
      if (current) endAssistant('', '');
      renderTodos(msg.todos ?? []);
      renderUsage(msg.usage);
      if (!msg.items.length && lastState) showWelcome(lastState.healthy, !!lastState.chatModel);
      scroll(true);
      return;
  }
}

window.addEventListener('message', (e) => handle(e.data));

// ---- User input ------------------------------------------------------------------------------

function submit(): void {
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  ui.historyPos = -1;
  hideSuggestions();
  if (ui.busy && !text.startsWith('/')) {
    ui.queue.push(text);
    renderQueue();
    return;
  }
  vscode.postMessage({ type: 'send', text });
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  submit();
});

input.addEventListener('input', () => updateSuggestions());
input.addEventListener('blur', () => setTimeout(hideSuggestions, 150));

input.addEventListener('keydown', (e) => {
  if (!suggestEl.hidden) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = suggest.items.length;
      suggest.active = (suggest.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      return renderSuggestions();
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      return acceptSuggestion();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      return hideSuggestions();
    }
  }
  if (e.key === 'Tab' && e.shiftKey) {
    e.preventDefault();
    const next = MODE_ORDER[(MODE_ORDER.indexOf(ui.mode) + 1) % MODE_ORDER.length];
    vscode.postMessage({ type: 'setMode', mode: next });
    return;
  }
  if (e.key === 'Escape' && ui.busy) {
    e.preventDefault();
    vscode.postMessage({ type: 'stop' });
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    return submit();
  }
  // Recall earlier messages with the arrow keys when the caret is on the first/last line.
  const atStart = !input.value.slice(0, input.selectionStart ?? 0).includes('\n');
  const atEnd = !input.value.slice(input.selectionEnd ?? 0).includes('\n');
  if (e.key === 'ArrowUp' && atStart && ui.sentHistory.length) {
    e.preventDefault();
    if (ui.historyPos === -1) {
      ui.draft = input.value;
      ui.historyPos = ui.sentHistory.length;
    }
    ui.historyPos = Math.max(0, ui.historyPos - 1);
    input.value = ui.sentHistory[ui.historyPos];
  } else if (e.key === 'ArrowDown' && atEnd && ui.historyPos !== -1) {
    e.preventDefault();
    ui.historyPos++;
    if (ui.historyPos >= ui.sentHistory.length) {
      ui.historyPos = -1;
      input.value = ui.draft;
    } else {
      input.value = ui.sentHistory[ui.historyPos];
    }
  }
});

log.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const copy = target.closest<HTMLElement>('[data-copy-code]');
  const insert = target.closest<HTMLElement>('[data-insert-code]');
  if (copy) {
    vscode.postMessage({ type: 'copy', text: codeBlocks[Number(copy.dataset.copyCode)] });
    copy.textContent = 'Copied';
    setTimeout(() => (copy.textContent = 'Copy'), 1200);
  } else if (insert) {
    vscode.postMessage({ type: 'insertCode', code: codeBlocks[Number(insert.dataset.insertCode)] });
  }
});

stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
$('newBtn').addEventListener('click', () => vscode.postMessage({ type: 'newChat' }));
$('historyBtn').addEventListener('click', () => (historyEl.hidden ? openHistory() : closeHistory()));
$('historyClose').addEventListener('click', closeHistory);
historySearch.addEventListener('input', renderHistory);
historySearch.addEventListener('keydown', (e) => e.key === 'Escape' && closeHistory());
modeBtn.addEventListener('click', () => {
  const next = MODE_ORDER[(MODE_ORDER.indexOf(ui.mode) + 1) % MODE_ORDER.length];
  vscode.postMessage({ type: 'setMode', mode: next });
});
editorChip.addEventListener('click', () => vscode.postMessage({ type: 'toggleEditor', value: !ui.includeEditor }));
titleEl.addEventListener('dblclick', () => {
  if (!ui.chatId) return;
  const field = el('input', 'rename');
  field.value = titleEl.textContent ?? '';
  let finished = false;
  const done = (save: boolean) => {
    if (finished) return;
    finished = true;
    if (save && field.value.trim()) vscode.postMessage({ type: 'renameChat', id: ui.chatId, title: field.value.trim() });
    field.replaceWith(titleEl);
  };
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') done(true);
    if (e.key === 'Escape') done(false);
  });
  field.addEventListener('blur', () => done(true), { once: true });
  titleEl.replaceWith(field);
  field.select();
});
modelSel.addEventListener('change', () => {
  if (modelSel.value) vscode.postMessage({ type: 'pickModel', name: modelSel.value });
  else vscode.postMessage({ type: 'command', command: 'mgbot.refreshModels' });
});

vscode.postMessage({ type: 'ready' });
input.focus();

export {};
