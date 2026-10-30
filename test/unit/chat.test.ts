import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatStore, titleFrom } from '../../src/chat/store';
import { extractMentions, rankPaths, splitThinking } from '../../src/chat/text';

describe('ChatStore', () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mgbot-chats-'));

  it('does not save empty chats', async () => {
    const d = dir();
    const store = new ChatStore(d);
    await store.save(store.create('m'));
    assert.deepStrictEqual(await store.list(), []);
  });

  it('saves, lists newest first, loads, renames and deletes chats', async () => {
    const d = dir();
    const store = new ChatStore(d);
    const a = store.create('m');
    a.title = 'First';
    a.history.push({ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' });
    a.transcript.push({ type: 'user', text: 'hi' });
    await store.save(a);
    await new Promise((r) => setTimeout(r, 5));
    const b = store.create('m');
    b.title = 'Second';
    b.history.push({ role: 'user', content: 'x' });
    await store.save(b);

    assert.deepStrictEqual((await store.list()).map((c) => c.title), ['Second', 'First']);
    const loaded = await store.load(a.id);
    assert.strictEqual(loaded?.history.length, 2);
    assert.strictEqual(loaded?.messageCount, 1);
    assert.deepStrictEqual(loaded?.transcript, [{ type: 'user', text: 'hi' }]);

    await store.rename(a.id, '  Renamed  ');
    const list = await store.list();
    assert.deepStrictEqual(list.map((c) => c.title), ['Second', 'Renamed']);

    // A fresh store (new VS Code session) reads the same index.
    assert.deepStrictEqual((await new ChatStore(d).list()).map((c) => c.id), [b.id, a.id]);

    await store.delete(b.id);
    assert.deepStrictEqual((await store.list()).map((c) => c.id), [a.id]);
    assert.strictEqual(await store.load(b.id), undefined);
  });

  it('rebuilds a missing index from the chat files', async () => {
    const d = dir();
    const store = new ChatStore(d);
    const a = store.create();
    a.history.push({ role: 'user', content: 'hi' });
    await store.save(a);
    fs.rmSync(path.join(d, 'index.json'));
    assert.deepStrictEqual((await new ChatStore(d).list()).map((c) => c.id), [a.id]);
  });

  it('rejects ids that could escape the folder', async () => {
    const store = new ChatStore(dir());
    assert.strictEqual(await store.load('../../etc/passwd'), undefined);
    await assert.rejects(store.delete('../x'));
  });
});

describe('chat text helpers', () => {
  it('makes short titles from the first line', () => {
    assert.strictEqual(titleFrom('Fix the login bug\nmore detail'), 'Fix the login bug');
    assert.strictEqual(titleFrom('@src/a.ts'), 'New chat');
    assert.ok(titleFrom('x'.repeat(100)).length <= 60);
  });

  it('extracts @file mentions but not emails', () => {
    assert.deepStrictEqual(extractMentions('look at @src/app.ts and @lib/ please, mail me@x.com'), ['src/app.ts', 'lib/']);
    assert.deepStrictEqual(extractMentions('@README.md.'), ['README.md']);
  });

  it('separates <think> reasoning from the answer', () => {
    assert.deepStrictEqual(splitThinking('<think>plan it</think>\nAnswer'), { content: 'Answer', thinking: 'plan it' });
    assert.deepStrictEqual(splitThinking('<think>still going'), { content: '', thinking: 'still going' });
    assert.deepStrictEqual(splitThinking('plain'), { content: 'plain', thinking: '' });
  });

  it('ranks file-name prefix matches above substring and fuzzy matches', () => {
    const paths = ['src/components/Button.tsx', 'src/app.ts', 'test/app.test.ts', 'docs/mapping.md', 'src/'];
    assert.deepStrictEqual(rankPaths(paths, 'app'), ['src/app.ts', 'test/app.test.ts', 'docs/mapping.md']);
    assert.deepStrictEqual(rankPaths(paths, 'sbtn'), ['src/components/Button.tsx']);
    assert.strictEqual(rankPaths(paths, '').length, 5);
  });
});
