import * as crypto from 'crypto';
import ignore, { Ignore } from 'ignore';
import * as path from 'path';
import * as vscode from 'vscode';
import { ProviderHolder, getConfig } from '../config';
import { chunkText, isProbablyBinary } from './chunker';
import { SearchHit, StoredChunk, VectorStore } from './vectorStore';

const DEFAULT_EXCLUDES = [
  '.git/', '.mgbot/', 'node_modules/', 'dist/', 'out/', 'build/', 'target/', 'bin/', 'obj/',
  '.venv/', 'venv/', '__pycache__/', '.next/', '.nuxt/', 'coverage/', 'vendor/',
  '*.lock', 'package-lock.json', 'pnpm-lock.yaml', '*.min.js', '*.min.css', '*.map',
  '*.png', '*.jpg', '*.jpeg', '*.gif', '*.ico', '*.webp', '*.pdf', '*.zip', '*.gz', '*.exe', '*.dll',
  '*.so', '*.dylib', '*.woff', '*.woff2', '*.ttf', '*.mp3', '*.mp4', '*.gguf', '*.bin', '*.onnx',
];
const EMBED_BATCH = 32;
const SAVE_EVERY_MS = 5000;

/**
 * Keeps a semantic index of the first workspace folder in `.mgbot/index`. Only files whose
 * content hash changed are re-embedded, so reopening a project is instant.
 */
export class CodeIndexer implements vscode.Disposable {
  private readonly store = new VectorStore();
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private readonly disposables: vscode.Disposable[] = [];
  private readonly queue = new Set<string>();
  private ignoreRules: { dir: string; ig: Ignore }[] = [];
  private running = false;
  private loaded = false;
  private lastSave = 0;
  private lastError = '';
  private debounce?: NodeJS.Timeout;

  constructor(private readonly providers: ProviderHolder) {
    this.disposables.push(this.status);
  }

  private get root(): vscode.Uri | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri;
  }

  private get indexDir(): string | undefined {
    return this.root && path.join(this.root.fsPath, '.mgbot', 'index');
  }

  get ready(): boolean {
    return this.loaded && this.store.size > 0;
  }

  async start(): Promise<void> {
    const root = this.root;
    if (!root) return;
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*'));
    watcher.onDidCreate((u) => this.enqueue(u), null, this.disposables);
    watcher.onDidChange((u) => this.enqueue(u), null, this.disposables);
    watcher.onDidDelete((u) => this.enqueue(u), null, this.disposables);
    this.disposables.push(watcher);
    this.disposables.push(vscode.workspace.onDidSaveTextDocument((d) => this.enqueue(d.uri)));
    await this.sync(false);
  }

  /** Loads the saved index and queues every file that is new, changed or deleted since. */
  async sync(rebuild: boolean): Promise<void> {
    const cfg = getConfig();
    const dir = this.indexDir;
    if (!dir) return;
    if (!cfg.indexEnabled) return this.setStatus('$(circle-slash) Index off', 'Code index disabled in settings (mgbot.index.enabled).');
    if (!cfg.embeddingModel) {
      return this.setStatus('$(database) Index: no embedding model', 'Pick an embedding model (e.g. nomic-embed-text) in the MG Bot Models view to enable semantic code search.');
    }

    if (!this.loaded || rebuild) {
      const ok = !rebuild && (await this.store.load(dir));
      if (!ok || this.store.model !== cfg.embeddingModel) this.store.reset(cfg.embeddingModel);
      this.loaded = true;
    }
    await this.loadIgnoreRules();

    const files = await this.listFiles();
    const present = new Set(files.map((u) => this.rel(u)));
    for (const known of [...this.store.files.keys()]) if (!present.has(known)) this.store.removeFile(known);
    for (const uri of files) this.queue.add(uri.fsPath);
    void this.drain();
  }

  async search(query: string, k = 8): Promise<SearchHit[]> {
    const cfg = getConfig();
    if (!cfg.embeddingModel || !this.store.size) return [];
    const [vec] = await this.providers.get().embed(cfg.embeddingModel, [this.prefix(cfg.embeddingModel, 'query') + query]);
    return this.store.search(vec, k);
  }

  private enqueue(uri: vscode.Uri): void {
    const cfg = getConfig();
    if (!cfg.indexEnabled || !cfg.embeddingModel || !this.loaded) return;
    if (uri.path.endsWith('/.gitignore')) void this.loadIgnoreRules();
    if (this.isIgnored(this.rel(uri))) return;
    this.queue.add(uri.fsPath);
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.drain(), 1500);
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const cfg = getConfig();
    let done = 0;
    try {
      while (this.queue.size) {
        const fsPath = this.queue.values().next().value as string;
        this.queue.delete(fsPath);
        this.setStatus(`$(sync~spin) Indexing ${this.queue.size} files`, 'MG Bot is embedding your codebase for semantic search.');
        try {
          await this.indexFile(vscode.Uri.file(fsPath), cfg.embeddingModel, cfg.indexMaxFileSizeKB);
          this.lastError = '';
        } catch (err) {
          this.lastError = (err as Error).message;
          // Runtime down or model missing: stop and keep the remaining work for the next sync.
          if (/fetch failed|ECONNREFUSED|not found|pull/i.test(this.lastError)) {
            this.queue.add(fsPath);
            break;
          }
        }
        done++;
        if (Date.now() - this.lastSave > SAVE_EVERY_MS) await this.save();
      }
      if (done) await this.save();
    } finally {
      this.running = false;
      this.updateIdleStatus();
    }
  }

  private async indexFile(uri: vscode.Uri, model: string, maxKB: number): Promise<void> {
    const rel = this.rel(uri);
    let bytes: Uint8Array;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type !== vscode.FileType.File || stat.size > maxKB * 1024) {
        this.store.removeFile(rel);
        return;
      }
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch {
      this.store.removeFile(rel); // deleted
      return;
    }
    if (isProbablyBinary(bytes)) return;
    const hash = crypto.createHash('sha1').update(bytes).digest('hex');
    if (this.store.files.get(rel) === hash) return;

    const text = Buffer.from(bytes).toString('utf8');
    const chunks: StoredChunk[] = chunkText(text).map((c) => ({ path: rel, startLine: c.startLine, endLine: c.endLine, text: c.text }));
    const vectors: number[][] = [];
    const prefix = this.prefix(model, 'document');
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const batch = chunks.slice(i, i + EMBED_BATCH).map((c) => `${prefix}File: ${rel}\n${c.text}`);
      vectors.push(...(await this.providers.get().embed(model, batch)));
    }
    this.store.upsertFile(rel, hash, chunks, vectors);
  }

  private async save(): Promise<void> {
    if (!this.indexDir) return;
    await this.store.save(this.indexDir);
    this.lastSave = Date.now();
    const gitignore = vscode.Uri.joinPath(this.root!, '.mgbot', '.gitignore');
    try {
      await vscode.workspace.fs.stat(gitignore);
    } catch {
      await vscode.workspace.fs.writeFile(gitignore, Buffer.from('index/\n', 'utf8'));
    }
  }

  private async listFiles(): Promise<vscode.Uri[]> {
    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(this.root!, '**/*'),
      '{**/node_modules/**,**/.git/**,**/.mgbot/**}',
    );
    return uris.filter((u) => !this.isIgnored(this.rel(u)));
  }

  private async loadIgnoreRules(): Promise<void> {
    const cfg = getConfig();
    const base = ignore().add(DEFAULT_EXCLUDES).add(cfg.indexExclude);
    const rules: { dir: string; ig: Ignore }[] = [{ dir: '', ig: base }];
    const files = await vscode.workspace.findFiles(new vscode.RelativePattern(this.root!, '**/.gitignore'), '**/node_modules/**');
    for (const f of files) {
      try {
        const text = Buffer.from(await vscode.workspace.fs.readFile(f)).toString('utf8');
        const dir = path.posix.dirname(this.rel(f));
        rules.push({ dir: dir === '.' ? '' : dir, ig: ignore().add(text) });
      } catch {
        // unreadable .gitignore — skip
      }
    }
    this.ignoreRules = rules;
  }

  private isIgnored(rel: string): boolean {
    if (!rel || rel.startsWith('..')) return true;
    return this.ignoreRules.some(({ dir, ig }) => {
      if (dir && !rel.startsWith(dir + '/')) return false;
      const sub = dir ? rel.slice(dir.length + 1) : rel;
      return sub ? ig.ignores(sub) : false;
    });
  }

  private rel(uri: vscode.Uri): string {
    return path.relative(this.root!.fsPath, uri.fsPath).split(path.sep).join('/');
  }

  /** Some embedding models expect task prefixes. */
  private prefix(model: string, kind: 'query' | 'document'): string {
    if (/nomic-embed/i.test(model)) return kind === 'query' ? 'search_query: ' : 'search_document: ';
    if (/mxbai-embed/i.test(model) && kind === 'query') return 'Represent this sentence for searching relevant passages: ';
    return '';
  }

  private updateIdleStatus(): void {
    if (this.lastError) {
      this.setStatus('$(warning) Index paused', `Indexing stopped: ${this.lastError}\nClick to retry.`, 'mgbot.syncIndex');
    } else {
      this.setStatus(`$(database) ${this.store.files.size} files indexed`, 'MG Bot code index is up to date. Click to rebuild from scratch.');
    }
  }

  private setStatus(text: string, tooltip: string, command = 'mgbot.rebuildIndex'): void {
    this.status.command = command;
    this.status.text = text;
    this.status.tooltip = tooltip;
    this.status.show();
  }

  dispose(): void {
    clearTimeout(this.debounce);
    this.disposables.forEach((d) => d.dispose());
  }
}
