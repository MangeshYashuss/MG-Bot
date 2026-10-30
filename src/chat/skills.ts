import * as fs from 'fs';
import * as path from 'path';
import type { SlashCommand } from './text';

/** A user-defined slash command: a markdown prompt in `.mgbot/skills/<name>.md`. */
export interface Skill extends SlashCommand {
  prompt: string;
}

export const SKILL_TEMPLATE = `---
description: One line shown in the / menu
---
Describe what MG Bot should do when you type this command.
Use $ARGUMENTS where the text typed after the command should go.
`;

/** Parses a skill file: optional `---` frontmatter with `description:`, then the prompt. */
export function parseSkill(name: string, text: string): Skill {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const prompt = (fm ? text.slice(fm[0].length) : text).trim();
  const described = fm && /^description:\s*(.+)$/m.exec(fm[1])?.[1].trim().replace(/^["']|["']$/g, '');
  return { name, description: described || prompt.split('\n')[0].replace(/^#+\s*/, '').slice(0, 80), prompt };
}

/** Puts the command's arguments where `$ARGUMENTS` is, or after the prompt when there is no placeholder. */
export function expandSkill(skill: Skill, args: string): string {
  if (skill.prompt.includes('$ARGUMENTS')) return skill.prompt.split('$ARGUMENTS').join(args);
  return args ? `${skill.prompt}\n\n${args}` : skill.prompt;
}

/** Loads `*.md` skills from each folder. Built-in commands and earlier folders win name clashes. */
export async function loadSkills(dirs: string[], reserved: string[]): Promise<Skill[]> {
  const seen = new Set(reserved);
  const out: Skill[] = [];
  for (const dir of dirs) {
    let files: string[];
    try {
      files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith('.md')).sort();
    } catch {
      continue; // Folder does not exist.
    }
    for (const f of files) {
      const name = f.slice(0, -3).toLowerCase().replace(/[^\w-]/g, '-');
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(parseSkill(name, await fs.promises.readFile(path.join(dir, f), 'utf8')));
    }
  }
  return out;
}
