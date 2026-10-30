import { parseArgs } from './ollama';
import {
  ChatMessage,
  ChatRequest,
  ChatResult,
  ModelInfo,
  ModelProvider,
  ProviderError,
  PullProgress,
  ToolsUnsupportedError,
  errorText,
  looksLikeToolsUnsupported,
  newCallId,
  readLines,
} from './types';

export const OPENAI_COMPAT_DEFAULT_ENDPOINT = 'http://localhost:1234/v1';

/** Works with LM Studio, llama.cpp `llama-server`, vLLM, LocalAI and other OpenAI-style local servers. */
export class OpenAICompatProvider implements ModelProvider {
  readonly id = 'openai-compatible' as const;
  readonly canManageModels = false;
  readonly endpoint: string;

  constructor(endpoint?: string) {
    let base = (endpoint || OPENAI_COMPAT_DEFAULT_ENDPOINT).replace(/\/+$/, '');
    if (!/\/v1$/.test(base)) base += '/v1';
    this.endpoint = base;
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.endpoint}/models`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await fetch(`${this.endpoint}/models`);
    if (!res.ok) throw new ProviderError(await errorText(res), res.status);
    const json = (await res.json()) as { data?: { id: string }[] };
    return (json.data ?? []).map((m) => ({ name: m.id }));
  }

  async pullModel(_name: string, _onProgress: (p: PullProgress) => void): Promise<void> {
    throw new ProviderError('This runtime does not support downloading models from VS Code. Download the model in the runtime itself (e.g. LM Studio), then refresh.');
  }

  async deleteModel(): Promise<void> {
    throw new ProviderError('This runtime does not support deleting models from VS Code.');
  }

  async contextLength(): Promise<number | undefined> {
    return undefined;
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.map(toOpenAIMessage),
      stream: true,
    };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ type: 'function', function: t }));
    }
    const res = await fetch(`${this.endpoint}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    // Tool calls arrive in fragments keyed by index; arguments are a JSON string built up across chunks.
    const partial = new Map<number, { id?: string; name: string; args: string }>();
    for await (const line of readLines(res.body)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') break;
      const chunk = JSON.parse(data);
      if (chunk.error) throw new ProviderError(chunk.error.message ?? String(chunk.error));
      if (chunk.usage) usage = { promptTokens: chunk.usage.prompt_tokens, completionTokens: chunk.usage.completion_tokens };
      const delta = chunk.choices?.[0]?.delta ?? {};
      // llama.cpp, LM Studio and vLLM stream reasoning under one of these names.
      const thought = delta.reasoning_content ?? delta.reasoning;
      if (thought) {
        thinking += thought;
        req.onThinking?.(thought);
      }
      if (delta.content) {
        content += delta.content;
        req.onToken?.(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const index = tc.index ?? 0;
        const entry = partial.get(index) ?? { name: '', args: '' };
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name += tc.function.name;
        if (tc.function?.arguments) entry.args += tc.function.arguments;
        partial.set(index, entry);
      }
    }
    const toolCalls = [...partial.values()]
      .filter((c) => c.name)
      .map((c) => ({ id: c.id ?? newCallId(), name: c.name, arguments: parseArgs(c.args) }));
    return { content, toolCalls, thinking: thinking || undefined, usage };
  }

  async embed(model: string, texts: string[], signal?: AbortSignal): Promise<number[][]> {
    const res = await fetch(`${this.endpoint}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: texts }),
      signal,
    });
    if (!res.ok) throw new ProviderError(await errorText(res), res.status);
    const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
    return [...json.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}

function toOpenAIMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.arguments) },
      })),
    };
  }
  return { role: m.role, content: m.content };
}
