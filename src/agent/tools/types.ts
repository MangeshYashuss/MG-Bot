import type { Todo } from '../../chat/store';
import type { ToolSpec } from '../../providers/types';
import type { CodeIndexer } from '../../memory/indexer';
import type { ProjectNotes } from '../../memory/notes';
import type { CommandRunner } from './commandTool';

export interface ApprovalRequest {
  kind: 'edit' | 'create' | 'command';
  title: string;
  detail: string;
}

export interface ToolContext {
  notes: ProjectNotes;
  indexer: CodeIndexer;
  commands: CommandRunner;
  signal: AbortSignal;
  /** True in "Edit automatically" mode: file changes skip the diff review. */
  autoApproveEdits: boolean;
  approve(req: ApprovalRequest): Promise<boolean>;
  setTodos(todos: Todo[]): void;
}

export interface Tool {
  spec: ToolSpec;
  /** Safe to use in plan mode (does not change files or run commands). */
  readOnly?: boolean;
  /** Short human-readable label for the chat UI, e.g. "src/app.ts". */
  label(args: Record<string, any>): string;
  run(args: Record<string, any>, ctx: ToolContext): Promise<string>;
}

export function str(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing required argument "${name}".`);
  return value;
}
