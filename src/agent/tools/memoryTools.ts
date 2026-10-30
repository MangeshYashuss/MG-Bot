import { MEMORY_SECTIONS } from '../../memory/notesFormat';
import { Tool, str } from './types';

export const rememberTool: Tool = {
  spec: {
    name: 'remember',
    description:
      'Save a durable fact about this project to its long-term memory (.mgbot/memory.md), which is loaded in every future session. Use it for architecture facts, conventions, decisions and the user\'s preferences, and for open TODOs — not for temporary details.',
    parameters: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'One concise, self-contained sentence.' },
        section: { type: 'string', enum: [...MEMORY_SECTIONS], description: 'Where to file it (default Notes).' },
      },
      required: ['note'],
    },
  },
  label: (a) => a.note ?? '',
  run: (args, ctx) => ctx.notes.remember(str(args.note, 'note'), args.section),
};

export const recallTool: Tool = {
  readOnly: true,
  spec: {
    name: 'recall',
    description: 'Read the project\'s long-term memory. Pass a query to get only matching entries.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Optional keywords.' } },
    },
  },
  label: (a) => a.query ?? 'all',
  run: (args, ctx) => ctx.notes.recall(args.query),
};
