import * as path from 'path';

export class PathError extends Error {}

export interface WorkspaceRoot {
  name: string;
  fsPath: string;
}

/**
 * Resolves a model-supplied path to an absolute path inside one of the workspace folders.
 * Relative paths resolve against the first folder, or against the folder whose name is the
 * first path segment in a multi-root workspace. Anything that escapes the workspace is rejected.
 */
export function resolveInWorkspace(roots: WorkspaceRoot[], input: string): { abs: string; root: WorkspaceRoot; rel: string } {
  if (!roots.length) throw new PathError('No folder is open in VS Code.');
  const cleaned = (input ?? '').trim().replace(/^["']|["']$/g, '') || '.';

  let candidates: { abs: string; root: WorkspaceRoot }[];
  if (path.isAbsolute(cleaned)) {
    candidates = roots.map((root) => ({ abs: path.resolve(cleaned), root }));
  } else {
    const [first, ...rest] = cleaned.split(/[\\/]/);
    const named = roots.length > 1 ? roots.find((r) => r.name === first) : undefined;
    candidates = named
      ? [{ abs: path.resolve(named.fsPath, rest.join('/') || '.'), root: named }]
      : [{ abs: path.resolve(roots[0].fsPath, cleaned), root: roots[0] }];
  }

  for (const { abs, root } of candidates) {
    const rel = path.relative(root.fsPath, abs);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      return { abs, root, rel: rel.split(path.sep).join('/') || '.' };
    }
  }
  throw new PathError(`Path "${input}" is outside the workspace.`);
}

/** Paths the agent must never write to. */
export function isProtectedPath(rel: string): boolean {
  const norm = rel.replace(/\\/g, '/');
  return /^(\.git|\.mgbot\/index)(\/|$)/.test(norm) || /(^|\/)\.git\//.test(norm);
}
