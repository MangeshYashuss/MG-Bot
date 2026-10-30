import type { Todo } from '../../chat/store';
import { Tool } from './types';

const STATUSES = new Set(['pending', 'in_progress', 'completed']);

export const todoWriteTool: Tool = {
  readOnly: true,
  spec: {
    name: 'todo_write',
    description:
      'Create or update the task list shown to the user. Use it for any request that needs 3 or more steps: list the steps, mark exactly one as in_progress while you work on it, and mark each completed as soon as it is done. Always send the full list.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'The step, in imperative form.' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
  },
  label: (a) => `${Array.isArray(a.todos) ? a.todos.length : 0} tasks`,
  async run(args, ctx) {
    if (!Array.isArray(args.todos)) throw new Error('"todos" must be an array.');
    const todos: Todo[] = args.todos
      .filter((t: any) => t && typeof t.content === 'string' && t.content.trim())
      .map((t: any) => ({ content: t.content.trim(), status: STATUSES.has(t.status) ? t.status : 'pending' }));
    ctx.setTodos(todos);
    const done = todos.filter((t) => t.status === 'completed').length;
    return `Task list updated (${done}/${todos.length} completed).`;
  },
};
