import * as fs from 'fs/promises';
import * as path from 'path';

export interface StoredChunk {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
}

export interface SearchHit extends StoredChunk {
  score: number;
}

interface Manifest {
  version: number;
  model: string;
  dim: number;
  files: Record<string, string>;
  chunks: StoredChunk[];
}

const VERSION = 1;

/**
 * Small on-disk vector store: `chunks.json` (metadata and text) plus `vectors.bin`
 * (normalized Float32 vectors in the same order). Brute-force cosine search in pure JS,
 * which stays fast up to around 100k chunks and needs no native modules.
 */
export class VectorStore {
  model = '';
  dim = 0;
  /** path → content hash of the indexed version. */
  files = new Map<string, string>();
  private chunks: StoredChunk[] = [];
  private vectors: Float32Array[] = [];

  get size(): number {
    return this.chunks.length;
  }

  reset(model: string): void {
    this.model = model;
    this.dim = 0;
    this.files.clear();
    this.chunks = [];
    this.vectors = [];
  }

  removeFile(filePath: string): void {
    this.files.delete(filePath);
    const keepChunks: StoredChunk[] = [];
    const keepVectors: Float32Array[] = [];
    this.chunks.forEach((c, i) => {
      if (c.path !== filePath) {
        keepChunks.push(c);
        keepVectors.push(this.vectors[i]);
      }
    });
    this.chunks = keepChunks;
    this.vectors = keepVectors;
  }

  upsertFile(filePath: string, hash: string, chunks: StoredChunk[], vectors: number[][]): void {
    if (chunks.length !== vectors.length) throw new Error('chunks and vectors length mismatch');
    this.removeFile(filePath);
    for (let i = 0; i < chunks.length; i++) {
      const v = normalize(vectors[i]);
      if (!this.dim) this.dim = v.length;
      if (v.length !== this.dim) throw new Error(`Embedding dimension changed (${v.length} vs ${this.dim}). Rebuild the index.`);
      this.chunks.push(chunks[i]);
      this.vectors.push(v);
    }
    this.files.set(filePath, hash);
  }

  search(query: number[], k = 8, filter?: (c: StoredChunk) => boolean): SearchHit[] {
    if (!this.vectors.length) return [];
    const q = normalize(query);
    if (q.length !== this.dim) return [];
    const hits: SearchHit[] = [];
    for (let i = 0; i < this.vectors.length; i++) {
      if (filter && !filter(this.chunks[i])) continue;
      const v = this.vectors[i];
      let dot = 0;
      for (let d = 0; d < v.length; d++) dot += v[d] * q[d];
      if (hits.length < k || dot > hits[hits.length - 1].score) {
        hits.push({ ...this.chunks[i], score: dot });
        hits.sort((a, b) => b.score - a.score);
        if (hits.length > k) hits.pop();
      }
    }
    return hits;
  }

  async save(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    const manifest: Manifest = {
      version: VERSION,
      model: this.model,
      dim: this.dim,
      files: Object.fromEntries(this.files),
      chunks: this.chunks,
    };
    const flat = new Float32Array(this.vectors.length * this.dim);
    this.vectors.forEach((v, i) => flat.set(v, i * this.dim));
    // Write to temp files then rename, so a crash never leaves a half-written index.
    await fs.writeFile(path.join(dir, 'vectors.bin.tmp'), Buffer.from(flat.buffer));
    await fs.writeFile(path.join(dir, 'chunks.json.tmp'), JSON.stringify(manifest));
    await fs.rename(path.join(dir, 'vectors.bin.tmp'), path.join(dir, 'vectors.bin'));
    await fs.rename(path.join(dir, 'chunks.json.tmp'), path.join(dir, 'chunks.json'));
  }

  /** Returns false when there is no usable index on disk. */
  async load(dir: string): Promise<boolean> {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(dir, 'chunks.json'), 'utf8')) as Manifest;
      if (manifest.version !== VERSION) return false;
      const buf = await fs.readFile(path.join(dir, 'vectors.bin'));
      const flat = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      if (flat.length !== manifest.chunks.length * manifest.dim) return false;
      this.model = manifest.model;
      this.dim = manifest.dim;
      this.files = new Map(Object.entries(manifest.files));
      this.chunks = manifest.chunks;
      this.vectors = manifest.chunks.map((_, i) => flat.slice(i * manifest.dim, (i + 1) * manifest.dim));
      return true;
    } catch {
      return false;
    }
  }
}

function normalize(v: number[] | Float32Array): Float32Array {
  const out = Float32Array.from(v);
  let norm = 0;
  for (let i = 0; i < out.length; i++) norm += out[i] * out[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}
