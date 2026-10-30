import {
  ChatMessage,
  ChatRequest,
  ChatResult,
  ModelInfo,
  ModelProvider,
  ProviderError,
  PullProgress,
  ToolCall,
  ToolsUnsupportedError,
  errorText,
  looksLikeToolsUnsupported,
  newCallId,
  readLines,
} from './types';

export const OLLAMA_DEFAULT_ENDPOINT = 'http://localhost:11434';

export class OllamaProvider implements ModelProvider {
  readonly id = 'ollama' as const;
  readonly canManageModels = true;
  readonly endpoint: string;

  constructor(endpoint?: string) {
    this.endpoint = (endpoint || OLLAMA_DEFAULT_ENDPOINT).replace(/\/+$/, '');
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.endpoint}/api/version`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await fetch(`${this.endpoint}/api/tags`);
    if (!res.ok) throw new ProviderError(await errorText(res), res.status);
    const json = (await res.json()) as { models?: any[] };
    return (json.models ?? []).map((m) => ({
      name: m.name,
      sizeBytes: m.size,
      parameterSize: m.details?.parameter_size,
      family: m.details?.family,
      remote: Boolean(m.remote_host),
    }));
  }

  async pullModel(name: string, onProgress: (p: PullProgress) => void, signal?: AbortSignal): Promise<void> {
    const res = await fetch(`${this.endpoint}/api/pull`, {
      method: 'POST',
      body: JSON.stringify({ model: name, stream: true }),
      signal,
    });
    if (!res.ok) throw new ProviderError(await errorText(res), res.status);
    for await (const line of readLines(res.body)) {
      const msg = JSON.parse(line);
      if (msg.error) throw new ProviderError(msg.error);
      onProgress({ status: msg.status, completed: msg.completed, total: msg.total });
    }
  }

  async deleteModel(name: string): Promise<void> {
    const res = await fetch(`${this.endpoint}/api/delete`, { method: 'DELETE', body: JSON.stringify({ model: name }) });
    if (!res.ok) throw new ProviderError(await errorText(res), res.status);
  }

  async contextLength(model: string): Promise<number | undefined> {
    try {
      const res = await fetch(`${this.endpoint}/api/show`, { method: 'POST', body: JSON.stringify({ model }) });
      if (!res.ok) return undefined;
      const json = (await res.json()) as { model_info?: Record<string, unknown> };
      for (const [key, value] of Object.entries(json.model_info ?? {})) {
        if (key.endsWith('.context_length') && typeof value === 'number') return value;
      }
    } catch {
      // Unknown; caller falls back to the configured size.
    }
    return undefined;
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.map(toOllamaMessage),
      stream: true,
      options: req.contextSize ? { num_ctx: req.contextSize } : undefined,
    };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ type: 'function', function: t }));
    }
    const res = await fetch(`${this.endpoint}/api/chat`, {
      method: 'POST',
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok) {
      const message = await errorText(res);
      if (req.tools?.length && looksLikeToolsUnsupported(res.status, message)) throw new ToolsUnsupportedError(message);
      throw new ProviderError(message, res.status);
    }

    let content = '';
    let thinking = '';
    let usage: ChatResult['usage'];
    const toolCalls: ToolCall[] = [];
    for await (const line of readLines(res.body)) {
      const msg = JSON.parse(line);
      if (msg.error) throw new ProviderError(msg.error);
      const thought: string = msg.message?.thinking ?? '';
      if (thought) {
        thinking += thought;
        req.onThinking?.(thought);
      }
      const piece: string = msg.message?.content ?? '';
      if (piece) {
        content += piece;
        req.onToken?.(piece);
      }
      if (msg.done) usage = { promptTokens: msg.prompt_eval_count, completionTokens: msg.eval_count };
      for (const call of msg.message?.tool_calls ?? []) {
        toolCalls.push({
          id: newCallId(),
          name: call.function?.name,
          arguments: parseArgs(call.function?.arguments),
        });
      }
    }
    return { content, toolCalls, thinking: thinking || undefined, usage };
  }

  async embed(model: string, texts: string[], signal?: AbortSignal): Promise<number[][]> {
    const res = await fetch(`${this.endpoint}/api/embed`, {
      method: 'POST',
      body: JSON.stringify({ model, input: texts, truncate: true }),
      signal,
    });
    if (!res.ok) throw new ProviderError(await errorText(res), res.status);
    const json = (await res.json()) as { embeddings: number[][] };
    return json.embeddings;
  }
}

function toOllamaMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'tool') return { role: 'tool', content: m.content, tool_name: m.name };
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content,
      tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.arguments } })),
    };
  }
  return { role: m.role, content: m.content };
}

export function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}
