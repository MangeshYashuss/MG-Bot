import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { workspaceRoots } from '../../config';
import { resolveInWorkspace } from '../../util/paths';
import { Tool, str } from './types';

const MAX_READ_LINES = 400;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.mgbot', '__pycache__', '.venv', 'venv']);

/** Reads a file, preferring the open editor's (possibly unsaved) text. */
export async function readText(uri: vscode.Uri): Promise<string> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) return open.getText();
  return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
}

export const readFileTool: Tool = {
  readOnly: true,
  spec: {
    name: 'read_file',
    description: `Read a text file in the workspace. Returns numbered lines (at most ${MAX_READ_LINES} per call; use startLine/endLine for more).`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the workspace root.' },
        startLine: { type: 'number', description: '1-based first line (optional).' },
        endLine: { type: 'number', description: '1-based last line, inclusive (optional).' },
      },
      required: ['path'],
    },
  },
  label: (a) => `${a.path ?? ''}${a.startLine ? `:${a.startLine}-${a.endLine ?? ''}` : ''}`,
  async run(args) {
    const { abs, rel } = resolveInWorkspace(workspaceRoots(), str(args.path, 'path'));
    const text = await readText(vscode.Uri.file(abs));
    const lines = text.split(/\r?\n/);
    const start = Math.max(1, Math.floor(Number(args.startLine) || 1));
    const end = Math.min(lines.length, Math.floor(Number(args.endLine) || start + MAX_READ_LINES - 1), start + MAX_READ_LINES - 1);
    const width = String(end).length;
    const body = lines
      .slice(start - 1, end)
      .map((l, i) => `${String(start + i).padStart(width)}| ${l}`)
      .join('\n');
    const more = end < lines.length ? `\n… ${lines.length - end} more lines. Call read_file with startLine=${end + 1} to continue.` : '';
    return `${rel} (lines ${start}-${end} of ${lines.length})\n${body}${more}`;
  },
};

export const listDirTool: Tool = {
  readOnly: true,
  spec: {
    name: 'list_dir',
    description: 'List files and folders. Folders end with "/". Use depth up to 3 to see nested folders.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Folder relative to the workspace root. Defaults to the root.' },
        depth: { type: 'number', description: 'How many levels to show (1-3, default 1).' },
      },
    },
  },
  label: (a) => a.path || '.',
  async run(args) {
    const { abs, rel } = resolveInWorkspace(workspaceRoots(), args.path || '.');
    const depth = Math.min(3, Math.max(1, Math.floor(Number(args.depth) || 1)));
    const out: string[] = [];
    const walk = async (dir: vscode.Uri, prefix: string, level: number) => {
      const entries = await vscode.workspace.fs.readDirectory(dir);
      entries.sort((a, b) => (b[1] === vscode.FileType.Directory ? 1 : 0) - (a[1] === vscode.FileType.Directory ? 1 : 0) || a[0].localeCompare(b[0]));
      for (const [name, type] of entries) {
        if (out.length >= 300) return;
        const isDir = (type & vscode.FileType.Directory) !== 0;
        out.push(`${prefix}${name}${isDir ? '/' : ''}`);
        if (isDir && level < depth && !SKIP_DIRS.has(name)) await walk(vscode.Uri.joinPath(dir, name), prefix + '  ', level + 1);
      }
    };
    await walk(vscode.Uri.file(abs), '', 1);
    return `${rel}/\n${out.join('\n')}${out.length >= 300 ? '\n… (truncated)' : ''}`;
  },
};

export const searchCodeTool: Tool = {
  readOnly: true,
  spec: {
    name: 'search_code',
    description: 'Exact text or regex search across the workspace (like grep). Best for identifiers, error messages and string literals.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text or regular expression to find.' },
        isRegex: { type: 'boolean', description: 'Treat query as a regular expression (default false).' },
        include: { type: 'string', description: 'Optional glob to limit files, e.g. "src/**/*.ts".' },
      },
      required: ['query'],
    },
  },
  label: (a) => `"${a.query ?? ''}"${a.include ? ` in ${a.include}` : ''}`,
  async run(args, ctx) {
    const query = str(args.query, 'query');
    const roots = workspaceRoots();
    if (!roots.length) throw new Error('No folder is open.');
    const rg = findRipgrep();
    const lines = rg ? await ripgrep(rg, roots[0].fsPath, query, !!args.isRegex, args.include, ctx.signal) : await jsSearch(query, !!args.isRegex, args.include);
    if (!lines.length) return `No matches for "${query}".`;
    return lines.slice(0, 100).join('\n') + (lines.length > 100 ? `\n… ${lines.length - 100} more matches; narrow the query or use include.` : '');
  },
};

export const semanticSearchTool: Tool = {
  readOnly: true,
  spec: {
    name: 'semantic_search',
    description: 'Search the codebase by meaning using the local code index, e.g. "where are user sessions validated". Returns the most relevant code chunks.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language description of the code you are looking for.' },
        k: { type: 'number', description: 'Number of results (default 6, max 15).' },
      },
      required: ['query'],
    },
  },
  label: (a) => `"${a.query ?? ''}"`,
  async run(args, ctx) {
    if (!ctx.indexer.ready) return 'The code index is not available yet (no embedding model selected or indexing still running). Use search_code or list_dir instead.';
    const hits = await ctx.indexer.search(str(args.query, 'query'), Math.min(15, Math.max(1, Number(args.k) || 6)));
    if (!hits.length) return 'No relevant code found.';
    return hits.map((h) => `### ${h.path}:${h.startLine}-${h.endLine} (score ${h.score.toFixed(2)})\n${h.text}`).join('\n\n');
  },
};

let rgPath: string | null | undefined;
/** VS Code ships ripgrep; reuse it instead of bundling our own binary. */
function findRipgrep(): string | null {
  if (rgPath !== undefined) return rgPath;
  const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const candidates = ['node_modules', 'node_modules.asar.unpacked'].flatMap((nm) => [
    path.join(vscode.env.appRoot, nm, '@vscode', 'ripgrep', 'bin', exe),
    path.join(vscode.env.appRoot, nm, 'vscode-ripgrep', 'bin', exe),
  ]);
  rgPath = candidates.find((c) => fs.existsSync(c)) ?? null;
  return rgPath;
}

function ripgrep(rg: string, cwd: string, query: string, isRegex: boolean, include: string | undefined, signal: AbortSignal): Promise<string[]> {
  const args = ['--line-number', '--no-heading', '--color', 'never', '--smart-case', '--max-count', '20', '--max-columns', '300', '--max-columns-preview'];
  if (!isRegex) args.push('--fixed-strings');
  if (include) args.push('--glob', include);
  args.push('--', query, '.');
  return new Promise((resolve, reject) => {
    execFile(rg, args, { cwd, maxBuffer: 8 * 1024 * 1024, signal }, (err, stdout) => {
      // Exit code 1 means "no matches".
      if (err && (err as any).code !== 1) return reject(new Error(`search failed: ${err.message}`));
      resolve(stdout.split(/\r?\n/).filter(Boolean).map((l) => l.replace(/^\.[\\/]/, '').replace(/\\/g, '/')));
    });
  });
}

async function jsSearch(query: string, isRegex: boolean, include?: string): Promise<string[]> {
  const re = isRegex ? new RegExp(query, 'i') : undefined;
  const needle = query.toLowerCase();
  const files = await vscode.workspace.findFiles(include || '**/*', '{**/node_modules/**,**/.git/**,**/.mgbot/**,**/dist/**,**/out/**}', 3000);
  const out: string[] = [];
  for (const uri of files) {
    if (out.length > 200) break;
    let text: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.length > 512 * 1024 || bytes.includes(0)) continue;
      text = Buffer.from(bytes).toString('utf8');
    } catch {
      continue;
    }
    const rel = vscode.workspace.asRelativePath(uri, false);
    text.split(/\r?\n/).forEach((line, i) => {
      if (re ? re.test(line) : line.toLowerCase().includes(needle)) out.push(`${rel}:${i + 1}:${line.slice(0, 300)}`);
    });
  }
  return out;
}
