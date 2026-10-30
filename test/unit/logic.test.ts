import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fitToBudget, messagesTokens } from '../../src/agent/context';
import { applySearchReplace, EditError } from '../../src/agent/tools/editLogic';
import { chunkText, isProbablyBinary } from '../../src/memory/chunker';
import { addNote, filterNotes, MEMORY_TEMPLATE } from '../../src/memory/notesFormat';
import { VectorStore } from '../../src/memory/vectorStore';
import { parseFallbackToolCalls, toFallbackMessages } from '../../src/providers/toolFallback';
import { ChatMessage } from '../../src/providers/types';
import { isAllowListed } from '../../src/util/commandPolicy';
import { isProtectedPath, resolveInWorkspace } from '../../src/util/paths';

const root = path.resolve(os.tmpdir(), 'ws');

describe('chunker', () => {
  it('splits into overlapping windows that cover every line', () => {
    const text = Array.from({ length: 130 }, (_, i) => `line ${i + 1}`).join('\n');
    const chunks = chunkText(text, 60, 10);
    assert.deepStrictEqual(chunks.map((c) => [c.startLine, c.endLine]), [[1, 60], [51, 110], [101, 130]]);
    assert.ok(chunks[2].text.endsWith('line 130'));
  });
  it('skips whitespace-only windows and detects binary', () => {
    assert.strictEqual(chunkText('\n\n   \n').length, 0);
    assert.ok(isProbablyBinary(new Uint8Array([65, 0, 66])));
    assert.ok(!isProbablyBinary(new TextEncoder().encode('plain text')));
  });
});

describe('VectorStore', () => {
  it('ranks by cosine similarity, replaces files and round-trips through disk', async () => {
    const store = new VectorStore();
    store.reset('m');
    const c = (p: string) => ({ path: p, startLine: 1, endLine: 1, text: p });
    store.upsertFile('a.ts', 'h1', [c('a.ts')], [[1, 0, 0]]);
    store.upsertFile('b.ts', 'h2', [c('b.ts')], [[0, 1, 0]]);
    store.upsertFile('c.ts', 'h3', [c('c.ts')], [[0.9, 0.1, 0]]);
    assert.deepStrictEqual(store.search([1, 0, 0], 2).map((h) => h.path), ['a.ts', 'c.ts']);

    store.upsertFile('a.ts', 'h1b', [c('a.ts')], [[0, 0, 1]]);
    assert.strictEqual(store.size, 3);
    assert.strictEqual(store.search([1, 0, 0], 1)[0].path, 'c.ts');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgbot-vs-'));
    await store.save(dir);
    const loaded = new VectorStore();
    assert.ok(await loaded.load(dir));
    assert.strictEqual(loaded.model, 'm');
    assert.strictEqual(loaded.files.get('a.ts'), 'h1b');
    assert.strictEqual(loaded.search([0, 0, 1], 1)[0].path, 'a.ts');

    loaded.removeFile('a.ts');
    assert.strictEqual(loaded.size, 2);
  });
  it('reports a missing index as not loaded', async () => {
    assert.strictEqual(await new VectorStore().load(path.join(os.tmpdir(), 'mgbot-missing-dir-xyz')), false);
  });
});

describe('fallback tool calls', () => {
  const known = new Set(['read_file', 'edit_file']);
  it('parses ```tool blocks and strips them from the text', () => {
    const text = 'Let me look.\n```tool\n{"name":"read_file","arguments":{"path":"a.ts"}}\n```';
    const { content, toolCalls } = parseFallbackToolCalls(text, known);
    assert.strictEqual(content, 'Let me look.');
    assert.strictEqual(toolCalls.length, 1);
    assert.deepStrictEqual(toolCalls[0].arguments, { path: 'a.ts' });
  });
  it('accepts json blocks naming a known tool, string arguments and multiple blocks', () => {
    const text = '```json\n{"name":"read_file","arguments":"{\\"path\\":\\"x\\"}"}\n```\n```tool\n{"name":"edit_file","arguments":{}}\n```';
    const { toolCalls } = parseFallbackToolCalls(text, known);
    assert.deepStrictEqual(toolCalls.map((t) => t.name), ['read_file', 'edit_file']);
    assert.deepStrictEqual(toolCalls[0].arguments, { path: 'x' });
  });
  it('leaves ordinary code blocks alone', () => {
    const text = 'Example:\n```json\n{"name":"package","version":"1.0.0"}\n```';
    const { content, toolCalls } = parseFallbackToolCalls(text, known);
    assert.strictEqual(toolCalls.length, 0);
    assert.strictEqual(content, text);
  });
  it('rewrites tool transcripts into plain turns', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'read_file', arguments: { path: 'a' } }] },
      { role: 'tool', name: 'read_file', toolCallId: '1', content: 'A' },
      { role: 'tool', name: 'read_file', toolCallId: '2', content: 'B' },
    ];
    const out = toFallbackMessages(msgs);
    assert.deepStrictEqual(out.map((m) => m.role), ['user', 'assistant', 'user']);
    assert.ok(out[1].content.includes('```tool'));
    assert.ok(out[2].content.includes('A') && out[2].content.includes('B'));
  });
});

describe('workspace path guard', () => {
  const roots = [{ name: 'ws', fsPath: root }];
  it('resolves relative paths inside the workspace', () => {
    assert.strictEqual(resolveInWorkspace(roots, 'src/a.ts').rel, 'src/a.ts');
    assert.strictEqual(resolveInWorkspace(roots, '.').rel, '.');
  });
  it('rejects escapes', () => {
    assert.throws(() => resolveInWorkspace(roots, '../secret.txt'));
    assert.throws(() => resolveInWorkspace(roots, path.resolve(root, '..', 'other', 'x')));
    assert.throws(() => resolveInWorkspace(roots, 'src/../../x'));
  });
  it('supports multi-root folder prefixes', () => {
    const multi = [roots[0], { name: 'api', fsPath: path.resolve(os.tmpdir(), 'api') }];
    assert.strictEqual(resolveInWorkspace(multi, 'api/server.ts').root.name, 'api');
  });
  it('protects .git and the index', () => {
    assert.ok(isProtectedPath('.git/config'));
    assert.ok(isProtectedPath('.mgbot/index/vectors.bin'));
    assert.ok(!isProtectedPath('.mgbot/memory.md'));
    assert.ok(!isProtectedPath('src/git.ts'));
  });
});

describe('command allow-list', () => {
  it('auto-approves only simple matching commands', () => {
    assert.ok(isAllowListed('npm test', ['npm test']));
    assert.ok(isAllowListed('npm test -- --grep x', ['npm test']));
    assert.ok(!isAllowListed('npm testing', ['npm test']));
    assert.ok(!isAllowListed('npm test && rm -rf /', ['npm test']));
    assert.ok(!isAllowListed('npm test; curl x', ['npm test']));
    assert.ok(!isAllowListed('git status', []));
  });
});

describe('search/replace edits', () => {
  it('applies exact unique replacements and keeps CRLF', () => {
    const out = applySearchReplace('a\r\nb\r\nc\r\n', [{ search: 'b', replace: 'B' }]);
    assert.strictEqual(out, 'a\r\nB\r\nc\r\n');
  });
  it('rejects ambiguous or missing search text', () => {
    assert.throws(() => applySearchReplace('x\nx\n', [{ search: 'x', replace: 'y' }]), EditError);
    assert.throws(() => applySearchReplace('abc', [{ search: 'zzz', replace: 'y' }]), EditError);
  });
  it('falls back to indentation-insensitive matching and re-indents', () => {
    const src = 'function f() {\n    if (a) {\n        return 1;\n    }\n}\n';
    const out = applySearchReplace(src, [{ search: 'if (a) {\n    return 1;\n}', replace: 'if (a) {\n    return 2;\n}' }]);
    assert.strictEqual(out, 'function f() {\n    if (a) {\n        return 2;\n    }\n}\n');
  });
});

describe('context budget', () => {
  const big = 'x'.repeat(3500);
  it('trims old tool output first, keeping the latest turn', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'read_file', arguments: {} }] },
      { role: 'tool', toolCallId: '1', name: 'read_file', content: big },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: '', toolCalls: [{ id: '2', name: 'read_file', arguments: {} }] },
      { role: 'tool', toolCallId: '2', name: 'read_file', content: big },
      { role: 'assistant', content: '', toolCalls: [{ id: '3', name: 'read_file', arguments: {} }] },
      { role: 'tool', toolCallId: '3', name: 'read_file', content: big },
    ];
    const out = fitToBudget(msgs, 2200);
    assert.ok(messagesTokens(out) <= 2200);
    assert.ok(out[2].content.startsWith('[older tool output trimmed'));
    assert.strictEqual(out[8].content, big);
    assert.strictEqual(out.length, msgs.length);
  });
  it('drops whole old turns when trimming is not enough, never the current one', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: big },
      { role: 'assistant', content: big },
      { role: 'user', content: 'current question' },
    ];
    const out = fitToBudget(msgs, 100);
    assert.deepStrictEqual(out, [{ role: 'user', content: 'current question' }]);
  });
});

describe('project memory format', () => {
  it('adds dated notes under the right section and ignores duplicates', () => {
    let { doc, added } = addNote(MEMORY_TEMPLATE, 'conventions', 'Use pnpm, not npm.', '2026-10-30');
    assert.ok(added);
    assert.match(doc, /## Conventions\n- 2026-10-30: Use pnpm, not npm\.\n/);
    ({ doc, added } = addNote(doc, 'Conventions', 'Use pnpm, not npm.', '2026-10-31'));
    assert.ok(!added);
    ({ doc } = addNote(doc, 'Conventions', 'Tabs for indentation.', '2026-10-31'));
    assert.match(doc, /- 2026-10-30: Use pnpm, not npm\.\n- 2026-10-31: Tabs for indentation\.\n/);
  });
  it('creates missing sections and starts from the template when empty', () => {
    const { doc } = addNote('', 'unknown-section', 'Something.', '2026-10-30');
    assert.match(doc, /## Notes\n- 2026-10-30: Something\./);
    const custom = addNote('# Mem\n', 'TODO', 'Finish auth.', '2026-10-30').doc;
    assert.match(custom, /## TODO\n- 2026-10-30: Finish auth\./);
  });
  it('filters by query keeping headings', () => {
    const { doc } = addNote(MEMORY_TEMPLATE, 'Decisions', 'Postgres is the main database.', '2026-10-30');
    assert.strictEqual(filterNotes(doc, 'database'), '## Decisions\n- 2026-10-30: Postgres is the main database.');
  });
});
