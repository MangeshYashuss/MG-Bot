import { parseArgs } from './ollama';
import { ChatMessage, ToolCall, ToolSpec, newCallId } from './types';

/**
 * Text protocol for models without native tool calling: tools are described in the
 * system prompt and the model answers with fenced ```tool blocks that we parse.
 */
export function fallbackToolInstructions(tools: ToolSpec[]): string {
  const list = tools
    .map((t) => `- ${t.name}: ${t.description}\n  arguments schema: ${JSON.stringify(t.parameters)}`)
    .join('\n');
  return [
    '## Calling tools',
    'To use a tool, reply with one or more fenced blocks exactly like this and then STOP writing:',
    '```tool',
    '{"name": "read_file", "arguments": {"path": "src/index.ts"}}',
    '```',
    'The tool results will be sent back to you in the next message. When you are done, answer normally without any tool block.',
    '',
    'Available tools:',
    list,
  ].join('\n');
}

const BLOCK = /```(tool|json|tool_call)?\s*\n([\s\S]*?)```/g;

/** Extracts tool calls from model text. Returns the text with the tool blocks removed. */
export function parseFallbackToolCalls(text: string, knownTools: Set<string>): { content: string; toolCalls: ToolCall[] } {
  const toolCalls: ToolCall[] = [];
  const content = text.replace(BLOCK, (whole, _lang: string | undefined, body: string) => {
    let found = 0;
    for (const obj of parseJsonObjects(body)) {
      const name = typeof obj.name === 'string' ? obj.name : typeof obj.tool === 'string' ? obj.tool : undefined;
      // A block is only a tool call if it names a known tool; other code blocks stay in the text.
      if (!name || !knownTools.has(name)) continue;
      toolCalls.push({ id: newCallId(), name, arguments: parseArgs(obj.arguments ?? obj.args ?? obj.parameters) });
      found++;
    }
    return found ? '' : whole;
  });
  return { content: content.trim(), toolCalls };
}

function parseJsonObjects(body: string): Record<string, any>[] {
  const trimmed = body.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.filter((x) => x && typeof x === 'object');
    return parsed && typeof parsed === 'object' ? [parsed] : [];
  } catch {
    // Some models put one JSON object per line.
    const out: Record<string, any>[] = [];
    for (const line of trimmed.split('\n')) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object') out.push(parsed);
      } catch {
        // ignore
      }
    }
    return out;
  }
}

/** Rewrites a native tool-call transcript into plain user/assistant turns for fallback mode. */
export function toFallbackMessages(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const blocks = m.toolCalls
        .map((c) => '```tool\n' + JSON.stringify({ name: c.name, arguments: c.arguments }) + '\n```')
        .join('\n');
      out.push({ role: 'assistant', content: [m.content, blocks].filter(Boolean).join('\n') });
    } else if (m.role === 'tool') {
      const text = `Result of tool ${m.name}:\n${m.content}`;
      const prev = out[out.length - 1];
      // Merge consecutive tool results into one user turn.
      if (prev?.role === 'user' && prev.content.startsWith('Result of tool')) prev.content += `\n\n${text}`;
      else out.push({ role: 'user', content: text });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}
