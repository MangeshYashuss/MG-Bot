import { OllamaProvider } from './ollama';
import { OpenAICompatProvider } from './openaiCompat';
import { ModelProvider } from './types';

export function createProvider(kind: string, endpoint: string): ModelProvider {
  return kind === 'openai-compatible' ? new OpenAICompatProvider(endpoint) : new OllamaProvider(endpoint);
}

export * from './types';
