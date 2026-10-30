import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Agent } from '../agent/loop';
import { ApprovalRequest } from '../agent/tools/types';
import { Skill, expandSkill, loadSkills } from '../chat/skills';
import { AgentMode, ChatSession, ChatStore, titleFrom } from '../chat/store';
import { INIT_PROMPT, SLASH_COMMANDS, extractMentions, rankPaths } from '../chat/text';
import { getConfig, workspaceRoots } from '../config';
import { McpManager } from '../mcp/manager';
import { ModelManager } from '../models/manager';
import { resolveInWorkspace } from '../util/paths';
import { chatHtml } from './markup';

const MAX_ATTACHMENT_CHARS = 30_000;
const FILE_LIST_TTL_MS = 30_000;

type FromWebview =
  | { type: 'ready' }
  | { type: 'send'; text: string }
  | { type: 'stop' }
  | { type: 'newChat' }
  | { type: 'approve'; id: string; approved: boolean }
  | { type: 'pickModel'; name: string }
  | { type: 'command'; command: string }
  | { type: 'setMode'; mode: AgentMode }
  | { type: 'toggleEditor'; value: boolean }
  | { type: 'listChats' }
  | { type: 'openChat'; id: string }
  | { type: 'renameChat'; id: string; title: string }
  | { type: 'deleteChat'; id: string }
  | { type: 'mentionQuery'; query: string }
  | { type: 'editFrom'; index: number }
  | { type: 'retryFrom'; index: number }
  | { type: 'copy'; text: string }
  | { type: 'insertCode'; code: string }
  | { type: 'executePlan' };

/**
 * The chat panel. Each chat is a saved session (see ChatStore); its transcript of UI events is
 * persisted so a chat looks the same when reopened, and its history is what the model sees.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'mgbot.chat';
  private view?: vscode.WebviewView;
  private session: ChatSession;
  private abort?: AbortController;
  /** Settles when the current request has fully finished (used before switching chats). */
  private running?: Promise<void>;
  private readonly approvals = new Map<string, (ok: boolean) => void>();
  private approvalCounter = 0;
  private saveTimer?: NodeJS.Timeout;
  private editorTimer?: NodeJS.Timeout;
  private fileList?: { at: number; paths: string[] };
  private skills: Skill[] = [];
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly state: vscode.Memento,
    private readonly store: ChatStore,
    private readonly agent: Agent,
    private readonly models: ModelManager,
    private readonly mcp: McpManager,
  ) {
    this.session = store.create(getConfig().chatModel);
    this.disposables.push(
      models.onDidChangeModels.event(() => this.postState()),
      vscode.window.onDidChangeActiveTextEditor(() => this.scheduleEditorUpdate()),
      vscode.window.onDidChangeTextEditorSelection(() => this.scheduleEditorUpdate()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.reloadSkills()),
    );
    for (const pattern of ['**/.mgbot/skills/*.md', new vscode.RelativePattern(vscode.Uri.file(globalSkillsDir()), '*.md')]) {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      watcher.onDidCreate(() => this.reloadSkills());
      watcher.onDidChange(() => this.reloadSkills());
      watcher.onDidDelete(() => this.reloadSkills());
      this.disposables.push(watcher);
    }
    void this.reloadSkills();
  }

  /** Skills from the project's .mgbot/skills, then from ~/.mgbot/skills. */
  private async reloadSkills(): Promise<void> {
    const dirs = [...workspaceRoots().map((r) => path.join(r.fsPath, '.mgbot', 'skills')), globalSkillsDir()];
    this.skills = await loadSkills(dirs, SLASH_COMMANDS.map((c) => c.name)).catch(() => []);
    this.postState();
  }

  private get commands() {
    return [...SLASH_COMMANDS, ...this.skills.map(({ name, description }) => ({ name, description }))];
  }

  /** Reopens the chat that was active when VS Code was last closed. */
  async restoreLastChat(): Promise<void> {
    const id = this.state.get<string>('mgbot.lastChat');
    const last = id && (await this.store.load(id));
    if (last) this.session = last;
  }

  private get mode(): AgentMode {
    return this.state.get<AgentMode>('mgbot.mode') ?? (getConfig().autoApproveEdits ? 'auto' : 'ask');
  }

  private get includeEditor(): boolean {
    return this.state.get<boolean>('mgbot.includeEditor') ?? true;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist'), vscode.Uri.joinPath(this.extensionUri, 'media')] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg: FromWebview) => this.onMessage(msg).catch((err) => this.notice((err as Error).message, 'error')));
  }

  get busy(): boolean {
    return !!this.abort;
  }

  // ---- Sending -------------------------------------------------------------------------------

  /** Sends a message. `prompt` replaces what the model sees (used by skills), `text` is what the chat shows. */
  async send(text: string, prompt?: string): Promise<void> {
    text = text.trim();
    if (!text) return;
    if (text.startsWith('/') && prompt === undefined) return this.slashCommand(text);
    if (this.abort) {
      this.notice('MG Bot is still working. Stop it first or wait for it to finish.', 'info');
      return;
    }
    await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);

    const session = this.session;
    if (!session.history.length) session.title = titleFrom(text);
    const content = await this.expandMentions(prompt ?? text);
    this.record({ type: 'user', text, histIndex: session.history.length });
    this.post({ type: 'busy', value: true });
    this.postState();

    const abort = (this.abort = new AbortController());
    let finished!: () => void;
    this.running = new Promise((r) => (finished = r));
    try {
      session.model = getConfig().chatModel;
      await this.agent.run(
        session,
        content,
        { mode: this.mode, includeEditor: this.includeEditor },
        {
          onAssistantStart: () => this.post({ type: 'assistantStart' }),
          onToken: (t) => this.post({ type: 'token', text: t }),
          onThinking: (t) => this.post({ type: 'thinking', text: t }),
          onAssistantEnd: (c, thinking) => {
            this.record({ type: 'assistantEnd', text: c, thinking });
            this.scheduleSave();
          },
          onToolStart: (id, name, label) => this.record({ type: 'toolStart', id, name, label }),
          onToolEnd: (id, ok, result) => {
            this.record({ type: 'toolEnd', id, ok, result: result.slice(0, 4000) });
            this.scheduleSave();
          },
          onNotice: (t) => this.notice(t, 'info'),
          onTodos: (todos) => this.post({ type: 'todos', todos }),
          onUsage: (used, max) => {
            session.usage = { used, max };
            this.post({ type: 'usage', used, max });
          },
          approve: (req) => this.requestApproval(req),
        },
        abort.signal,
      );
    } catch (err) {
      const e = err as Error;
      this.post({ type: 'assistantEnd', text: '', thinking: '' });
      if (e.name === 'AbortError' || abort.signal.aborted) this.notice('Stopped.', 'info');
      else this.notice(friendlyError(e), 'error');
    } finally {
      this.abort = undefined;
      this.cancelApprovals();
      this.post({ type: 'busy', value: false });
      await this.saveNow(session);
      finished();
    }
  }

  /** Stops any running request and waits for it to wind down. */
  private async stopAndWait(): Promise<void> {
    if (!this.abort) return;
    this.stop();
    await this.running;
  }

  private async slashCommand(text: string): Promise<void> {
    const [name, ...rest] = text.slice(1).split(/\s+/);
    const skill = this.skills.find((s) => s.name === name.toLowerCase());
    if (skill) return this.send(text, expandSkill(skill, text.slice(1 + name.length).trim()));
    switch (name.toLowerCase()) {
      case 'new':
      case 'clear':
        return this.newChat();
      case 'compact':
        return this.compact();
      case 'init':
        return this.send(INIT_PROMPT + (rest.length ? `\n\nAlso: ${rest.join(' ')}` : ''));
      case 'memory':
        await vscode.commands.executeCommand('mgbot.openMemory');
        return;
      case 'history':
        this.post({ type: 'showHistory' });
        return this.postChatList();
      case 'model':
        return this.pickModel();
      case 'mcp':
        return this.notice(await this.mcp.status(), 'info');
      case 'help':
        return this.notice(
          [
            'Commands: ' + this.commands.map((c) => `/${c.name} — ${c.description}`).join(' · '),
            'Add your own commands as markdown files in .mgbot/skills/ (project) or ~/.mgbot/skills/ (everywhere) — run "MG Bot: New Skill".',
            'Shortcuts: Enter sends · Shift+Enter new line · Shift+Tab switches mode · ↑ recalls earlier messages · @ attaches a file · Esc stops',
          ].join('\n'),
          'info',
        );
      default:
        return this.notice(`Unknown command /${name}. Type /help to see the commands.`, 'error');
    }
  }

  /** Appends the contents of @-mentioned files (or folder listings) to the message sent to the model. */
  private async expandMentions(text: string): Promise<string> {
    const attachments: string[] = [];
    for (const mention of extractMentions(text)) {
      try {
        const { abs, rel } = resolveInWorkspace(workspaceRoots(), mention);
        const uri = vscode.Uri.file(abs);
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type & vscode.FileType.Directory) {
          const entries = await vscode.workspace.fs.readDirectory(uri);
          const list = entries.map(([n, t]) => (t & vscode.FileType.Directory ? `${n}/` : n)).sort().join('\n');
          attachments.push(`<attached_folder path="${rel}">\n${list}\n</attached_folder>`);
        } else {
          let body = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
          if (body.includes('\u0000')) continue;
          if (body.length > MAX_ATTACHMENT_CHARS) body = body.slice(0, MAX_ATTACHMENT_CHARS) + '\n…(truncated — use read_file for the rest)';
          attachments.push(`<attached_file path="${rel}">\n${body}\n</attached_file>`);
        }
      } catch {
        // Not a workspace path (e.g. an @decorator in a question) — leave the text as is.
      }
    }
    return attachments.length ? `${text}\n\n${attachments.join('\n\n')}` : text;
  }

  // ---- Chats -----------------------------------------------------------------------------------

  async newChat(): Promise<void> {
    await this.stopAndWait();
    await this.saveNow();
    this.session = this.store.create(getConfig().chatModel);
    await this.state.update('mgbot.lastChat', undefined);
    this.replay();
  }

  async openChat(id: string): Promise<void> {
    if (id === this.session.id) return;
    if (this.abort) {
      this.notice('Stop the current request before switching chats.', 'error');
      return;
    }
    const session = await this.store.load(id);
    if (!session) {
      this.notice('That chat could not be found. It may have been deleted.', 'error');
      return this.postChatList();
    }
    await this.saveNow();
    this.session = session;
    await this.state.update('mgbot.lastChat', id);
    this.replay();
  }

  async showHistoryPicker(): Promise<void> {
    const chats = await this.store.list();
    if (!chats.length) {
      vscode.window.showInformationMessage('No saved chats for this project yet.');
      return;
    }
    const pick = await vscode.window.showQuickPick(
      chats.map((c) => ({ label: c.title, description: relativeTime(c.updatedAt), detail: `${c.messageCount} messages${c.model ? ` · ${c.model}` : ''}`, id: c.id })),
      { title: 'MG Bot — chats in this project', matchOnDetail: true },
    );
    if (pick) {
      await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
      await this.openChat(pick.id);
    }
  }

  private async compact(): Promise<void> {
    if (this.abort) return this.notice('Wait for the current request to finish before compacting.', 'error');
    if (!this.session.history.length) return this.notice('Nothing to compact yet.', 'info');
    const abort = (this.abort = new AbortController());
    this.post({ type: 'busy', value: true });
    this.notice('Compacting the conversation…', 'info');
    try {
      this.post({ type: 'assistantStart' });
      const summary = await this.agent.compact(this.session, abort.signal, (t) => this.post({ type: 'token', text: t }));
      this.post({ type: 'assistantEnd', text: '', thinking: '' });
      // The transcript is replaced too, so the chat shows exactly what the model now remembers.
      this.session.transcript = [
        { type: 'notice', text: 'Earlier conversation was compacted into this summary.', level: 'info', tIndex: 0 },
        { type: 'assistantStart', tIndex: 1 },
        { type: 'assistantEnd', text: summary, thinking: '', tIndex: 2 },
      ];
      this.session.usage = undefined;
      await this.saveNow();
      this.replay();
    } catch (err) {
      this.post({ type: 'assistantEnd', text: '', thinking: '' });
      this.notice(`Compact failed: ${friendlyError(err as Error)}`, 'error');
    } finally {
      this.abort = undefined;
      this.post({ type: 'busy', value: false });
    }
  }

  /** Drops the chat from a user message onwards (file changes already made are kept). */
  private async truncateFrom(index: number): Promise<string | undefined> {
    if (this.abort) {
      this.notice('Stop the current request first.', 'error');
      return undefined;
    }
    const item = this.session.transcript[index];
    if (item?.type !== 'user') return undefined;
    this.session.history = this.session.history.slice(0, item.histIndex);
    this.session.transcript = this.session.transcript.slice(0, index);
    if (!this.session.history.length) this.session.todos = [];
    await this.saveNow();
    this.replay();
    return item.text as string;
  }

  private async pickModel(): Promise<void> {
    const pick = await vscode.window.showQuickPick(
      this.models.models.map((m) => ({ label: m.name, description: m.name === getConfig().chatModel ? 'current' : m.remote ? 'cloud' : '' })),
      { title: 'Chat model' },
    );
    if (pick) await this.models.setChatModel(pick.label);
  }

  // ---- Webview messages -----------------------------------------------------------------------

  private async onMessage(msg: FromWebview): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.replay();
        this.postEditor();
        break;
      case 'send':
        await this.send(msg.text);
        break;
      case 'stop':
        this.stop();
        break;
      case 'newChat':
        await this.newChat();
        break;
      case 'approve':
        this.approvals.get(msg.id)?.(msg.approved);
        break;
      case 'pickModel':
        await this.models.setChatModel(msg.name);
        break;
      case 'command':
        if (msg.command.startsWith('mgbot.')) await vscode.commands.executeCommand(msg.command);
        break;
      case 'setMode':
        await this.state.update('mgbot.mode', msg.mode);
        this.postState();
        break;
      case 'toggleEditor':
        await this.state.update('mgbot.includeEditor', msg.value);
        this.postState();
        break;
      case 'listChats':
        await this.postChatList();
        break;
      case 'openChat':
        await this.openChat(msg.id);
        break;
      case 'renameChat':
        if (msg.id === this.session.id) {
          this.session.title = msg.title.trim().slice(0, 100) || this.session.title;
          await this.saveNow();
        }
        await this.store.rename(msg.id, msg.title);
        this.postState();
        await this.postChatList();
        break;
      case 'deleteChat':
        if (msg.id === this.session.id) await this.stopAndWait();
        await this.store.delete(msg.id);
        if (msg.id === this.session.id) {
          this.session = this.store.create(getConfig().chatModel);
          await this.state.update('mgbot.lastChat', undefined);
          this.replay();
        }
        await this.postChatList();
        break;
      case 'mentionQuery':
        this.post({ type: 'mentionResults', query: msg.query, items: rankPaths(await this.workspaceFiles(), msg.query) });
        break;
      case 'editFrom': {
        const text = await this.truncateFrom(msg.index);
        if (text !== undefined) this.post({ type: 'fillInput', text });
        break;
      }
      case 'retryFrom': {
        const text = await this.truncateFrom(msg.index);
        if (text !== undefined) await this.send(text);
        break;
      }
      case 'copy':
        await vscode.env.clipboard.writeText(msg.text);
        break;
      case 'insertCode':
        await this.insertCode(msg.code);
        break;
      case 'executePlan':
        await this.state.update('mgbot.mode', 'ask');
        this.postState();
        await this.send('The plan looks good. Go ahead and implement it, keeping the task list up to date.');
        break;
    }
  }

  stop(): void {
    this.abort?.abort();
    this.cancelApprovals();
  }

  private async insertCode(code: string): Promise<void> {
    const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === 'file') ?? vscode.window.activeTextEditor;
    if (!editor) {
      const doc = await vscode.workspace.openTextDocument({ content: code });
      await vscode.window.showTextDocument(doc);
      return;
    }
    await editor.edit((b) => b.replace(editor.selection, code));
  }

  private async workspaceFiles(): Promise<string[]> {
    if (this.fileList && Date.now() - this.fileList.at < FILE_LIST_TTL_MS) return this.fileList.paths;
    const uris = await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/.git/**,**/.mgbot/index/**,**/dist/**,**/out/**}', 10_000);
    const files = uris.map((u) => vscode.workspace.asRelativePath(u, (vscode.workspace.workspaceFolders?.length ?? 0) > 1));
    const dirs = new Set<string>();
    for (const f of files) {
      const parts = f.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/') + '/');
    }
    this.fileList = { at: Date.now(), paths: [...files, ...dirs] };
    return this.fileList.paths;
  }

  private requestApproval(req: ApprovalRequest): Promise<boolean> {
    const id = `ap${Date.now().toString(36)}${++this.approvalCounter}`;
    this.record({ type: 'approval', id, kind: req.kind, title: req.title, detail: req.detail });
    return new Promise((resolve) => {
      this.approvals.set(id, (ok) => {
        this.approvals.delete(id);
        this.record({ type: 'approvalDone', id, approved: ok });
        resolve(ok);
      });
    });
  }

  private cancelApprovals(): void {
    for (const resolve of [...this.approvals.values()]) resolve(false);
  }

  // ---- Posting ---------------------------------------------------------------------------------

  /** Posts a message and keeps it in the session transcript so the chat can be redrawn later. */
  private record(msg: Record<string, unknown>): void {
    msg.tIndex = this.session.transcript.length;
    this.session.transcript.push(msg);
    this.post(msg);
  }

  private post(msg: Record<string, unknown>): void {
    this.view?.webview.postMessage(msg);
  }

  private notice(text: string, level: 'info' | 'error'): void {
    this.record({ type: 'notice', text, level });
  }

  private replay(): void {
    this.post({ type: 'replay', items: this.session.transcript, todos: this.session.todos, usage: this.session.usage ?? null });
    this.postState();
  }

  postState(): void {
    const cfg = getConfig();
    this.post({
      type: 'state',
      models: this.models.models.map((m) => ({ name: m.name, remote: m.remote })),
      chatModel: cfg.chatModel,
      healthy: this.models.isHealthy,
      runtime: cfg.provider === 'ollama' ? 'Ollama' : 'OpenAI-compatible',
      mode: this.mode,
      includeEditor: this.includeEditor,
      chatId: this.session.id,
      title: this.session.title,
      busy: this.busy,
      commands: this.commands,
    });
  }

  private async postChatList(): Promise<void> {
    const chats = await this.store.list();
    this.post({ type: 'chatList', currentId: this.session.id, items: chats.map((c) => ({ ...c, when: relativeTime(c.updatedAt) })) });
  }

  private scheduleEditorUpdate(): void {
    clearTimeout(this.editorTimer);
    this.editorTimer = setTimeout(() => this.postEditor(), 200);
  }

  private postEditor(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      this.post({ type: 'editor', path: null });
      return;
    }
    const sel = editor.selection;
    this.post({
      type: 'editor',
      path: vscode.workspace.asRelativePath(editor.document.uri),
      selection: sel.isEmpty ? null : { start: sel.start.line + 1, end: sel.end.line + (sel.end.character === 0 && sel.end.line > sel.start.line ? 0 : 1) },
    });
  }

  private scheduleSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.saveNow(), 1000);
  }

  private async saveNow(session = this.session): Promise<void> {
    clearTimeout(this.saveTimer);
    if (!session.history.length) return;
    try {
      await this.store.save(session);
      if (session === this.session) await this.state.update('mgbot.lastChat', session.id);
    } catch (err) {
      console.error('MG Bot: could not save chat', err);
    }
  }

  async dispose(): Promise<void> {
    this.stop();
    clearTimeout(this.editorTimer);
    this.disposables.forEach((d) => d.dispose());
    await this.saveNow();
  }

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.css'));
    const codicons = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'codicon.css'));
    return chatHtml({ nonce, cspSource: webview.cspSource, scriptUri: script.toString(), styleUri: style.toString(), codiconUri: codicons.toString(), commands: this.commands });
  }
}

export function globalSkillsDir(): string {
  return path.join(os.homedir(), '.mgbot', 'skills');
}

function friendlyError(e: Error): string {
  const m = e.message;
  if (/fetch failed|ECONNREFUSED/i.test(m)) return 'Could not reach the model runtime. Is Ollama (or your local server) running? Check the Models view.';
  if (/not found/i.test(m) && /model/i.test(m)) return `${m} — download it in the Models view or pick another model.`;
  return m;
}

export function relativeTime(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} d ago`;
  return new Date(ts).toLocaleDateString();
}
