/** `@path` mentions in a chat message (emails and decorators like `foo@bar` are ignored). */
export function extractMentions(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(^|\s)@([\w./\\-]*[\w/])/g)) out.add(m[2].replace(/\\/g, '/'));
  return [...out];
}

/** Separates `<think>…</think>` reasoning that some models emit inline from the answer. */
export function splitThinking(text: string): { content: string; thinking: string } {
  const parts: string[] = [];
  const content = text.replace(/<think>([\s\S]*?)(<\/think>|$)/g, (_m, inner: string) => {
    parts.push(inner.trim());
    return '';
  });
  return { content: content.trim(), thinking: parts.filter(Boolean).join('\n\n') };
}

/**
 * Ranks workspace paths for the @-mention picker: file-name prefix matches first, then
 * substring matches, then fuzzy (in-order characters) matches; shorter paths win ties.
 */
export function rankPaths(paths: string[], query: string, limit = 15): string[] {
  const q = query.toLowerCase().replace(/\\/g, '/');
  if (!q) return paths.slice(0, limit);
  const scored: { p: string; s: number }[] = [];
  for (const p of paths) {
    const lower = p.toLowerCase();
    const base = lower.slice(lower.lastIndexOf('/', lower.length - 2) + 1);
    let s: number;
    if (base.startsWith(q)) s = 0;
    else if (base.includes(q)) s = 1;
    else if (lower.includes(q)) s = 2;
    else if (isSubsequence(q, lower)) s = 3;
    else continue;
    scored.push({ p, s });
  }
  return scored.sort((a, b) => a.s - b.s || a.p.length - b.p.length || a.p.localeCompare(b.p)).slice(0, limit).map((x) => x.p);
}

function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (const ch of hay) if (ch === needle[i] && ++i === needle.length) return true;
  return false;
}

export interface SlashCommand {
  name: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'new', description: 'Start a new chat' },
  { name: 'clear', description: 'Clear this chat and start over' },
  { name: 'compact', description: 'Summarize the conversation so far to free up context' },
  { name: 'init', description: 'Study this project and save what matters to project memory' },
  { name: 'memory', description: 'Open the project memory file' },
  { name: 'history', description: 'Show previous chats for this project' },
  { name: 'model', description: 'Switch the chat model' },
  { name: 'help', description: 'Show commands and shortcuts' },
];

export const INIT_PROMPT = `Study this project so future sessions start with the right context:
1. Look at the top-level layout, README, package/build files and main entry points.
2. Work out how to install, build, run and test it.
3. Identify the architecture, key modules and coding conventions.
Then save each important fact with the remember tool (Architecture, Conventions, Decisions, TODO). Finish with a short overview for me.`;

export const COMPACT_PROMPT =
  'Summarize the conversation so far so it can replace the full history. Keep: the user\'s goals and requests, decisions made, files examined or changed (with paths), commands run and their outcomes, open problems and next steps. Be concise but complete. Output only the summary.';
