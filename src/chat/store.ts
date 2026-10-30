import * as fs from 'fs/promises';
import * as path from 'path';
import { ChatMessage } from '../providers/types';

export type AgentMode = 'ask' | 'auto' | 'plan';

export interface Todo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface ChatSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  model?: string;
}

export interface ChatSession extends ChatSummary {
  /** What the model sees (excluding the system prompt). */
  history: ChatMessage[];
  /** UI events used to redraw the conversation when it is reopened. */
  transcript: any[];
  todos: Todo[];
  /** Last known context usage, for the meter. */
  usage?: { used: number; max: number };
}

/**
 * Saves each chat as its own JSON file in the extension's per-workspace storage, so every
 * project has its own chat history and nothing is written into the user's repository.
 */
export class ChatStore {
  private index?: ChatSummary[];

  constructor(private readonly dir: string) {}

  create(model?: string): ChatSession {
    const now = Date.now();
    return {
      id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      title: 'New chat',
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      model,
      history: [],
      transcript: [],
      todos: [],
    };
  }

  async list(): Promise<ChatSummary[]> {
    if (!this.index) {
      try {
        this.index = JSON.parse(await fs.readFile(path.join(this.dir, 'index.json'), 'utf8')) as ChatSummary[];
      } catch {
        this.index = await this.rebuildIndex();
      }
    }
    return [...this.index].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async load(id: string): Promise<ChatSession | undefined> {
    try {
      const session = JSON.parse(await fs.readFile(this.file(id), 'utf8')) as ChatSession;
      session.todos ??= [];
      session.transcript ??= [];
      return session;
    } catch {
      return undefined;
    }
  }

  /** Empty chats are never written, so opening and closing "New chat" leaves no clutter. */
  async save(session: ChatSession): Promise<void> {
    if (!session.history.length) return;
    session.updatedAt = Date.now();
    session.messageCount = session.history.filter((m) => m.role === 'user').length;
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = this.file(session.id) + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(session));
    await fs.rename(tmp, this.file(session.id));
    await this.updateIndex((list) => [...list.filter((s) => s.id !== session.id), summarize(session)]);
  }

  async rename(id: string, title: string): Promise<void> {
    const session = await this.load(id);
    if (!session) return;
    session.title = title.trim().slice(0, 100) || session.title;
    // Written directly (not via save) so renaming doesn't move the chat to the top of the list.
    await fs.writeFile(this.file(id), JSON.stringify(session));
    await this.updateIndex((list) => list.map((s) => (s.id === id ? summarize(session) : s)));
  }

  async delete(id: string): Promise<void> {
    await fs.rm(this.file(id), { force: true });
    await this.updateIndex((list) => list.filter((s) => s.id !== id));
  }

  private async updateIndex(fn: (list: ChatSummary[]) => ChatSummary[]): Promise<void> {
    this.index = fn(await this.list());
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(path.join(this.dir, 'index.json'), JSON.stringify(this.index));
  }

  /** Recovers the index from the chat files if index.json is missing or corrupt. */
  private async rebuildIndex(): Promise<ChatSummary[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const out: ChatSummary[] = [];
    for (const name of names) {
      if (!name.endsWith('.json') || name === 'index.json') continue;
      const s = await this.load(name.slice(0, -5));
      if (s) out.push(summarize(s));
    }
    return out;
  }

  private file(id: string): string {
    if (!/^[\w-]+$/.test(id)) throw new Error(`Invalid chat id: ${id}`);
    return path.join(this.dir, `${id}.json`);
  }
}

function summarize(s: ChatSession): ChatSummary {
  return { id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt, messageCount: s.messageCount, model: s.model };
}

export function titleFrom(text: string): string {
  const firstLine = text.replace(/@\S+/g, '').trim().split('\n')[0].trim();
  if (!firstLine) return 'New chat';
  return firstLine.length > 60 ? firstLine.slice(0, 57).trimEnd() + '…' : firstLine;
}
