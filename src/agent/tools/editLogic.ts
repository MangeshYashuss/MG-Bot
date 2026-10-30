export interface SearchReplace {
  search: string;
  replace: string;
}

export class EditError extends Error {}

/**
 * Applies search/replace blocks in order. Each search must match exactly once; when the exact
 * text is not found, a match that ignores leading/trailing whitespace on each line is tried,
 * because small models often get indentation slightly wrong.
 */
export function applySearchReplace(original: string, edits: SearchReplace[]): string {
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  let text = original.replace(/\r\n/g, '\n');
  edits.forEach((edit, n) => {
    const search = (edit.search ?? '').replace(/\r\n/g, '\n');
    const replace = (edit.replace ?? '').replace(/\r\n/g, '\n');
    if (!search) {
      if (text.trim()) throw new EditError(`Edit ${n + 1}: "search" is empty. Use create_file for new files, or quote the text to replace.`);
      text = replace;
      return;
    }
    const first = text.indexOf(search);
    if (first >= 0) {
      if (text.indexOf(search, first + 1) >= 0) {
        throw new EditError(`Edit ${n + 1}: the search text matches more than once. Include more surrounding lines so it is unique.`);
      }
      text = text.slice(0, first) + replace + text.slice(first + search.length);
      return;
    }
    const loose = looseMatch(text, search);
    if (!loose) {
      throw new EditError(`Edit ${n + 1}: search text not found. Re-read the file with read_file and copy the exact lines.`);
    }
    const replaced = reindent(replace, loose.indent);
    text = text.slice(0, loose.start) + replaced + text.slice(loose.end);
  });
  return eol === '\n' ? text : text.replace(/\n/g, eol);
}

function looseMatch(text: string, search: string): { start: number; end: number; indent: string } | undefined {
  const lines = text.split('\n');
  const needle = search.split('\n').map((l) => l.trim());
  while (needle.length && !needle[needle.length - 1]) needle.pop();
  while (needle.length && !needle[0]) needle.shift();
  if (!needle.length) return undefined;

  const matches: number[] = [];
  for (let i = 0; i + needle.length <= lines.length; i++) {
    if (needle.every((n, j) => lines[i + j].trim() === n)) matches.push(i);
  }
  if (matches.length !== 1) {
    if (matches.length > 1) throw new EditError('The search text matches more than once. Include more surrounding lines so it is unique.');
    return undefined;
  }
  const startLine = matches[0];
  const offsets = [0];
  for (const l of lines) offsets.push(offsets[offsets.length - 1] + l.length + 1);
  const start = offsets[startLine];
  const end = offsets[startLine + needle.length] - 1;
  return { start, end, indent: /^\s*/.exec(lines[startLine])![0] };
}

/** Shifts a replacement block so its first line uses the file's indentation. */
function reindent(block: string, indent: string): string {
  const lines = block.split('\n');
  const firstIndent = /^\s*/.exec(lines.find((l) => l.trim()) ?? '')![0];
  return lines
    .map((l) => (l.startsWith(firstIndent) ? indent + l.slice(firstIndent.length) : l.trim() ? indent + l.trimStart() : l))
    .join('\n');
}
