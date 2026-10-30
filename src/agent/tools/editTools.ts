import * as path from 'path';
import * as vscode from 'vscode';
import { workspaceRoots } from '../../config';
import { PathError, isProtectedPath, resolveInWorkspace } from '../../util/paths';
import { SearchReplace, applySearchReplace } from './editLogic';
import { readText } from './fsTools';
import { Tool, ToolContext, str } from './types';

export const PROPOSED_SCHEME = 'mgbot-proposed';

/** Serves proposed file contents to the diff editor. */
export class ProposedContentProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  set(uri: vscode.Uri, text: string): void {
    this.contents.set(uri.toString(), text);
    this.changed.fire(uri);
  }

  delete(uri: vscode.Uri): void {
    this.contents.delete(uri.toString());
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }
}

export const proposedContent = new ProposedContentProvider();
let proposalCounter = 0;

/** Shows a diff, asks for approval (unless auto-approved), then writes the file. */
async function proposeAndApply(ctx: ToolContext, kind: 'edit' | 'create', fileUri: vscode.Uri, rel: string, before: string, after: string): Promise<string> {
  if (before === after) return `No changes to ${rel}.`;
  const autoApprove = ctx.autoApproveEdits;
  const id = ++proposalCounter;
  const left = vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: `/original/${id}/${rel}` });
  const right = vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: `/proposed/${id}/${rel}` });
  proposedContent.set(left, before);
  proposedContent.set(right, after);

  let approved = true;
  try {
    if (!autoApprove) {
      await vscode.commands.executeCommand('vscode.diff', left, right, `MG Bot: ${rel} (proposed)`, { preview: true });
      approved = await ctx.approve({
        kind,
        title: kind === 'create' ? `Create ${rel}` : `Edit ${rel}`,
        detail: diffStats(before, after),
      });
      await closeProposalTabs(right);
    }
  } finally {
    proposedContent.delete(left);
    proposedContent.delete(right);
  }
  if (!approved) return `The user rejected the change to ${rel}. Ask what they want instead, or try a different approach.`;

  await writeFile(fileUri, after);
  if (autoApprove || kind === 'create') {
    await vscode.window.showTextDocument(fileUri, { preview: true, preserveFocus: true });
  }
  return `${kind === 'create' ? 'Created' : 'Updated'} ${rel} (${diffStats(before, after)}).`;
}

async function writeFile(uri: vscode.Uri, text: string): Promise<void> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(open.positionAt(0), open.positionAt(open.getText().length)), text);
    await vscode.workspace.applyEdit(edit);
    await open.save();
    return;
  }
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
}

async function closeProposalTabs(right: vscode.Uri): Promise<void> {
  const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter(
    (t) => t.input instanceof vscode.TabInputTextDiff && t.input.modified.toString() === right.toString(),
  );
  if (tabs.length) await vscode.window.tabGroups.close(tabs);
}

function diffStats(before: string, after: string): string {
  const a = before ? before.split(/\r?\n/) : [];
  const b = after.split(/\r?\n/);
  const setA = new Map<string, number>();
  a.forEach((l) => setA.set(l, (setA.get(l) ?? 0) + 1));
  let common = 0;
  for (const l of b) {
    const n = setA.get(l) ?? 0;
    if (n > 0) {
      common++;
      setA.set(l, n - 1);
    }
  }
  return `+${b.length - common} −${a.length - common} lines`;
}

function resolveWritable(p: string): { uri: vscode.Uri; rel: string } {
  const { abs, rel } = resolveInWorkspace(workspaceRoots(), p);
  if (isProtectedPath(rel)) throw new PathError(`Writing to ${rel} is not allowed.`);
  return { uri: vscode.Uri.file(abs), rel };
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

export const editFileTool: Tool = {
  spec: {
    name: 'edit_file',
    description:
      'Change an existing file with search/replace blocks. Each "search" must be copied exactly from the current file (read it first) and must match once; include a few surrounding lines to make it unique. The user reviews a diff before it is applied.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        edits: {
          type: 'array',
          description: 'Replacements applied in order.',
          items: {
            type: 'object',
            properties: {
              search: { type: 'string', description: 'Exact existing text to replace.' },
              replace: { type: 'string', description: 'New text.' },
            },
            required: ['search', 'replace'],
          },
        },
      },
      required: ['path', 'edits'],
    },
  },
  label: (a) => a.path ?? '',
  async run(args, ctx) {
    const { uri, rel } = resolveWritable(str(args.path, 'path'));
    if (!(await exists(uri))) throw new Error(`${rel} does not exist. Use create_file to make a new file.`);
    const edits = (Array.isArray(args.edits) ? args.edits : args.search !== undefined ? [args] : []) as SearchReplace[];
    if (!edits.length) throw new Error('Provide at least one {search, replace} edit.');
    const before = await readText(uri);
    const after = applySearchReplace(before, edits);
    return proposeAndApply(ctx, 'edit', uri, rel, before, after);
  },
};

export const createFileTool: Tool = {
  spec: {
    name: 'create_file',
    description: 'Create a new file with the given content (parent folders are created). Set overwrite=true to replace an existing file entirely.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        content: { type: 'string', description: 'Full file content.' },
        overwrite: { type: 'boolean', description: 'Replace the file if it already exists (default false).' },
      },
      required: ['path', 'content'],
    },
  },
  label: (a) => a.path ?? '',
  async run(args, ctx) {
    const { uri, rel } = resolveWritable(str(args.path, 'path'));
    const content = typeof args.content === 'string' ? args.content : '';
    const already = await exists(uri);
    if (already && !args.overwrite) throw new Error(`${rel} already exists. Use edit_file, or pass overwrite=true to replace it.`);
    const before = already ? await readText(uri) : '';
    return proposeAndApply(ctx, already ? 'edit' : 'create', uri, rel, before, content);
  },
};
