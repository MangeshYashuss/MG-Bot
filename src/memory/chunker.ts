export interface Chunk {
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  text: string;
}

/** Splits text into overlapping line windows, skipping windows that are only whitespace. */
export function chunkText(text: string, maxLines = 60, overlap = 10, maxChars = 4000): Chunk[] {
  const lines = text.split(/\r?\n/);
  const step = Math.max(1, maxLines - overlap);
  const chunks: Chunk[] = [];
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(lines.length, start + maxLines);
    let body = lines.slice(start, end).join('\n');
    if (!body.trim()) {
      if (end >= lines.length) break;
      continue;
    }
    if (body.length > maxChars) body = body.slice(0, maxChars);
    chunks.push({ startLine: start + 1, endLine: end, text: body });
    if (end >= lines.length) break;
  }
  return chunks;
}

/** Heuristic binary check: a NUL byte in the first 8 KB. */
export function isProbablyBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}
