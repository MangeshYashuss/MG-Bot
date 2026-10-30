import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { ProviderHolder, getConfig } from '../config';
import { MEMORY_TEMPLATE, addNote, filterNotes } from './notesFormat';

/** Above this size the prompt gets a cached summary instead of the full file. */
const PROMPT_BUDGET_CHARS = 6000;

/** Project memory kept in `.mgbot/memory.md` of the first workspace folder. */
export class ProjectNotes {
  constructor(private readonly providers: ProviderHolder) {}

  get uri(): vscode.Uri | undefined {
    const root = vscode.workspace.workspaceFolders?.[0];
    return root && vscode.Uri.joinPath(root.uri, '.mgbot', 'memory.md');
  }

  async read(): Promise<string> {
    const uri = this.uri;
    if (!uri) return '';
    try {
      return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    } catch {
      return '';
    }
  }

  async ensureExists(): Promise<vscode.Uri | undefined> {
    const uri = this.uri;
    if (!uri) return undefined;
    if (!(await this.read())) {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(MEMORY_TEMPLATE, 'utf8'));
      await this.ensureGitignore();
    }
    return uri;
  }

  async remember(note: string, section?: string): Promise<string> {
    const uri = await this.ensureExists();
    if (!uri) return 'No folder is open, so there is nowhere to store project memory.';
    const today = new Date().toISOString().slice(0, 10);
    const { doc, added } = addNote(await this.read(), section, note, today);
    if (!added) return 'Already in project memory.';
    await vscode.workspace.fs.writeFile(uri, Buffer.from(doc, 'utf8'));
    return `Saved to project memory (${section ?? 'Notes'}).`;
  }

  async recall(query?: string): Promise<string> {
    const doc = await this.read();
    return doc ? filterNotes(doc, query) : 'Project memory is empty.';
  }

  /** Text injected into every system prompt. Large files are summarized once and cached by hash. */
  async forPrompt(signal?: AbortSignal): Promise<string> {
    const doc = (await this.read()).replace(/<!--[\s\S]*?-->/g, '').trim();
    if (!doc || doc.length <= PROMPT_BUDGET_CHARS) return doc;

    const root = vscode.workspace.workspaceFolders![0].uri;
    const hash = crypto.createHash('sha1').update(doc).digest('hex').slice(0, 12);
    const cacheUri = vscode.Uri.joinPath(root, '.mgbot', 'index', `memory-summary-${hash}.md`);
    try {
      return Buffer.from(await vscode.workspace.fs.readFile(cacheUri)).toString('utf8');
    } catch {
      // Not cached yet.
    }
    const cfg = getConfig();
    if (!cfg.chatModel) return doc.slice(0, PROMPT_BUDGET_CHARS);
    try {
      const res = await this.providers.get().chat({
        model: cfg.chatModel,
        contextSize: cfg.contextSize,
        signal,
        messages: [
          {
            role: 'system',
            content:
              'Condense this project memory to under 4000 characters. Keep every decision, convention and open TODO; merge duplicates; drop obsolete items. Keep the same markdown headings. Output only the markdown.',
          },
          { role: 'user', content: doc },
        ],
      });
      const summary = res.content.trim();
      await vscode.workspace.fs.writeFile(cacheUri, Buffer.from(summary, 'utf8'));
      return summary + '\n\n(Summary — call `recall` for the full project memory.)';
    } catch {
      return doc.slice(0, PROMPT_BUDGET_CHARS) + '\n…(truncated — call `recall` for more)';
    }
  }

  /** Keeps the index (machine-specific, large) out of git while memory.md stays shareable. */
  async ensureGitignore(): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) return;
    const uri = vscode.Uri.joinPath(root.uri, '.mgbot', '.gitignore');
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      await vscode.workspace.fs.writeFile(uri, Buffer.from('index/\n', 'utf8'));
    }
  }
}
