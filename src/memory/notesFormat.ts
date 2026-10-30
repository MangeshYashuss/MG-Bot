export const MEMORY_SECTIONS = ['Architecture', 'Conventions', 'Decisions', 'TODO', 'Notes'] as const;
export type MemorySection = (typeof MEMORY_SECTIONS)[number];

export const MEMORY_TEMPLATE = `# Project Memory

<!-- Maintained by MG Bot. Read at the start of every session. Edit freely; commit it to share with your team. -->

## Architecture

## Conventions

## Decisions

## TODO

## Notes
`;

export function normalizeSection(section: string | undefined): MemorySection {
  const match = MEMORY_SECTIONS.find((s) => s.toLowerCase() === (section ?? '').trim().toLowerCase());
  return match ?? 'Notes';
}

/** Adds a dated bullet to a section, creating the section if needed. Returns the doc unchanged for duplicates. */
export function addNote(doc: string, section: string | undefined, note: string, date: string): { doc: string; added: boolean } {
  const text = note.replace(/\s+/g, ' ').trim();
  if (!text) return { doc, added: false };
  const normalizedExisting = doc.toLowerCase();
  if (normalizedExisting.includes(text.toLowerCase())) return { doc, added: false };

  const heading = `## ${normalizeSection(section)}`;
  const bullet = `- ${date}: ${text}`;
  const lines = (doc.trim() ? doc : MEMORY_TEMPLATE).replace(/\r\n/g, '\n').split('\n');
  let h = lines.findIndex((l) => l.trim().toLowerCase() === heading.toLowerCase());
  if (h < 0) {
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    lines.push('', heading);
    h = lines.length - 1;
  }
  // Insert after the last non-empty line of the section.
  let insertAt = h + 1;
  for (let i = h + 1; i < lines.length && !/^#{1,2} /.test(lines[i]); i++) {
    if (lines[i].trim()) insertAt = i + 1;
  }
  lines.splice(insertAt, 0, bullet);
  let out = lines.join('\n');
  if (!out.endsWith('\n')) out += '\n';
  return { doc: out, added: true };
}

/** Returns the lines of the memory relevant to a query (section headings are kept for context). */
export function filterNotes(doc: string, query: string | undefined): string {
  const terms = (query ?? '').toLowerCase().split(/\W+/).filter((t) => t.length > 2);
  if (!terms.length) return doc;
  const out: string[] = [];
  let currentHeading = '';
  for (const line of doc.split(/\r?\n/)) {
    if (/^#{1,2} /.test(line)) {
      currentHeading = line;
      continue;
    }
    const lower = line.toLowerCase();
    if (line.trim() && terms.some((t) => lower.includes(t))) {
      if (currentHeading) {
        out.push(currentHeading);
        currentHeading = '';
      }
      out.push(line);
    }
  }
  return out.length ? out.join('\n') : `No memory entries match "${query}".`;
}
