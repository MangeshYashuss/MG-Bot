import { ChatMessage } from '../providers/types';

/** Rough token estimate (about 3.5 characters per token for code-heavy text). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export function messagesTokens(messages: ChatMessage[]): number {
  return messages.reduce(
    (sum, m) => sum + 4 + estimateTokens(m.content) + (m.toolCalls ? estimateTokens(JSON.stringify(m.toolCalls)) : 0),
    0,
  );
}

const TRIMMED = '[older tool output trimmed to save context — call the tool again if you still need it]';

/**
 * Fits a conversation (excluding the system prompt) into `budget` tokens without breaking
 * tool-call/result pairs:
 *  1. replace old tool outputs (all but the last `keepRecentTools`) with a stub,
 *  2. drop whole old turns (a turn starts at a user message), never the current one,
 *  3. truncate the largest remaining tool outputs.
 */
export function fitToBudget(messages: ChatMessage[], budget: number, keepRecentTools = 2): ChatMessage[] {
  let out = messages.map((m) => ({ ...m }));
  if (messagesTokens(out) <= budget) return out;

  const toolIdx = out.flatMap((m, i) => (m.role === 'tool' ? [i] : []));
  for (const i of toolIdx.slice(0, Math.max(0, toolIdx.length - keepRecentTools))) {
    if (messagesTokens(out) <= budget) return out;
    out[i].content = TRIMMED;
  }

  const turnStarts = out.flatMap((m, i) => (m.role === 'user' ? [i] : []));
  while (messagesTokens(out) > budget && turnStarts.length > 1) {
    const end = turnStarts[1];
    out = out.slice(end);
    const shift = end;
    turnStarts.shift();
    for (let k = 0; k < turnStarts.length; k++) turnStarts[k] -= shift;
  }

  while (messagesTokens(out) > budget) {
    let biggest = -1;
    for (let i = 0; i < out.length; i++) {
      if (out[i].role === 'tool' && out[i].content.length > 2000 && (biggest < 0 || out[i].content.length > out[biggest].content.length)) {
        biggest = i;
      }
    }
    if (biggest < 0) break;
    const c = out[biggest].content;
    out[biggest].content = c.slice(0, Math.floor(c.length / 2)) + '\n…[truncated]';
  }
  return out;
}
