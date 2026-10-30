export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: Role;
  content: string;
  /** Tool calls requested by an assistant message. */
  toolCalls?: ToolCall[];
  /** For role 'tool': the call this message answers. */
  toolCallId?: string;
  /** For role 'tool': the tool name. */
  name?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  /** Omit to call the model without native tool support. */
  tools?: ToolSpec[];
  contextSize?: number;
  signal?: AbortSignal;
  onToken?: (text: string) => void;
  /** Reasoning text from thinking models, streamed separately from the answer. */
  onThinking?: (text: string) => void;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  thinking?: string;
  /** Token counts reported by the runtime, when available. */
  usage?: { promptTokens?: number; completionTokens?: number };
}

export interface ModelInfo {
  name: string;
  sizeBytes?: number;
  parameterSize?: string;
  family?: string;
  remote?: boolean;
}

export interface PullProgress {
  status: string;
  completed?: number;
  total?: number;
}

export interface ModelProvider {
  readonly id: 'ollama' | 'openai-compatible';
  readonly endpoint: string;
  /** True when the runtime can download and delete models itself. */
  readonly canManageModels: boolean;
  health(): Promise<boolean>;
  listModels(): Promise<ModelInfo[]>;
  pullModel(name: string, onProgress: (p: PullProgress) => void, signal?: AbortSignal): Promise<void>;
  deleteModel(name: string): Promise<void>;
  chat(req: ChatRequest): Promise<ChatResult>;
  embed(model: string, texts: string[], signal?: AbortSignal): Promise<number[][]>;
  /** Maximum context length reported by the runtime, if known. */
  contextLength(model: string): Promise<number | undefined>;
}

/** Thrown when the model or runtime rejects native tool calling. */
export class ToolsUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolsUnsupportedError';
  }
}

export class ProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ProviderError';
  }
}

let callCounter = 0;
export function newCallId(): string {
  callCounter = (callCounter + 1) % 1_000_000;
  return `call_${Date.now().toString(36)}_${callCounter}`;
}

/** Yields complete lines from a streamed fetch body. */
export async function* readLines(body: ReadableStream<Uint8Array> | null): AsyncGenerator<string> {
  if (!body) return;
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (line.trim()) yield line;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield buffer;
}

export async function errorText(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const json = JSON.parse(text);
    return json.error?.message ?? json.error ?? text;
  } catch {
    return text || res.statusText;
  }
}

export function looksLikeToolsUnsupported(status: number, message: string): boolean {
  return status >= 400 && status < 500 && /tool/i.test(message) && /support|not allowed|invalid|unknown/i.test(message);
}
