import * as os from 'os';
import type { AgentMode, Todo } from '../chat/store';
import { SearchHit } from '../memory/vectorStore';

export interface PromptParts {
  workspaceNames: string[];
  memory: string;
  relevantCode: SearchHit[];
  editor?: { path: string; language: string; selection?: string; cursorLine: number };
  fallbackTools?: string;
  mode?: AgentMode;
  todos?: Todo[];
}

export function buildSystemPrompt(p: PromptParts): string {
  const shell = process.platform === 'win32' ? 'PowerShell on Windows' : `${process.env.SHELL || 'sh'} on ${os.type()}`;
  const sections: string[] = [
    `You are MG Bot, an expert software engineer working inside the user's VS Code workspace (${p.workspaceNames.join(', ') || 'no folder open'}). You run on a local model on the user's machine.`,
    [
      '## How to work',
      '- Use the tools to look at the real code before answering or changing it. Never guess file contents or paths.',
      '- Prefer semantic_search to find code by meaning and search_code for exact names; read_file before editing.',
      '- Make focused changes with edit_file (exact search/replace) or create_file. The user approves every change.',
      `- Use run_command to build, test or inspect (${shell}). Avoid destructive or long-running commands.`,
      '- After changing code, verify it when you can (run the tests or build), then summarize what you changed.',
      '- For work with 3 or more steps, keep a task list with todo_write and update it as you go.',
      '- Files the user attaches with @path are included in their message; you do not need to read them again.',
      '- Keep answers concise. Use markdown and fenced code blocks. Refer to files as path:line.',
      '- If the request is ambiguous or risky, ask a short clarifying question instead of guessing.',
    ].join('\n'),
    [
      '## Long-term project memory',
      'You have a persistent memory for this project that survives restarts. Call `remember` whenever you learn something future sessions will need: architecture, conventions, decisions the user makes, their preferences, and unfinished TODOs. Do not store secrets or credentials.',
      p.memory ? `Current memory:\n<project_memory>\n${p.memory}\n</project_memory>` : 'The memory is currently empty — build it up as you learn the project.',
    ].join('\n'),
  ];

  if (p.mode === 'plan') {
    sections.push(
      '## PLAN MODE\nYou are in plan mode: you may only investigate (read, search, recall, todo_write). Do NOT try to edit files or run commands. Explore enough to be confident, then reply with a clear, numbered implementation plan: files to change, what to change in each, and how to verify. The user will approve the plan before anything changes.',
    );
  } else if (p.mode === 'auto') {
    sections.push('## Mode\nThe user enabled automatic edits: file changes are applied without a review step, so be careful and precise. Commands still need approval.');
  }

  if (p.todos?.length) {
    const icon = { pending: '[ ]', in_progress: '[~]', completed: '[x]' } as const;
    sections.push(`## Current task list\n${p.todos.map((t) => `${icon[t.status]} ${t.content}`).join('\n')}`);
  }

  if (p.relevantCode.length) {
    const code = p.relevantCode
      .map((h) => `### ${h.path}:${h.startLine}-${h.endLine}\n\`\`\`\n${h.text.slice(0, 1500)}\n\`\`\``)
      .join('\n');
    sections.push(`## Possibly relevant code (from the semantic index; may be incomplete — read files to confirm)\n${code}`);
  }

  if (p.editor) {
    const sel = p.editor.selection ? `\nSelected text:\n\`\`\`${p.editor.language}\n${p.editor.selection.slice(0, 4000)}\n\`\`\`` : '';
    sections.push(`## Editor\nThe user has ${p.editor.path} open (cursor at line ${p.editor.cursorLine}).${sel}`);
  }

  if (p.fallbackTools) sections.push(p.fallbackTools);
  return sections.join('\n\n');
}
