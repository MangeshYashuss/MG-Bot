import * as assert from 'assert';
import * as fs from 'fs';
import { JSDOM } from 'jsdom';
import * as path from 'path';
import { SLASH_COMMANDS } from '../../src/chat/text';
import { chatHtml } from '../../src/webview/markup';

// Runs the bundled webview script (dist/webview.js, built by `npm run build`) against the real markup.
const bundle = path.resolve(__dirname, '../../../dist/webview.js');

function load() {
  const html = chatHtml({ nonce: 'n', cspSource: '', scriptUri: '', styleUri: '', codiconUri: '', commands: SLASH_COMMANDS }).replace(/<script[^>]*src=[^>]*><\/script>/, '');
  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  const sent: any[] = [];
  const w = dom.window as any;
  // Copy messages out of the jsdom realm so deepStrictEqual compares plain objects.
  w.acquireVsCodeApi = () => ({ postMessage: (m: unknown) => sent.push(JSON.parse(JSON.stringify(m))) });
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.eval(fs.readFileSync(bundle, 'utf8'));
  const doc = w.document as Document;
  const post = (data: unknown) => w.dispatchEvent(new w.MessageEvent('message', { data }));
  const $ = (sel: string) => doc.querySelector(sel) as HTMLElement;
  const key = (target: HTMLElement, k: string, extra: Record<string, unknown> = {}) =>
    target.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
  return { w, doc, sent, post, $, key };
}

const state = { type: 'state', models: [{ name: 'qwen' }], chatModel: 'qwen', healthy: true, runtime: 'Ollama', mode: 'ask', includeEditor: true, chatId: 'c1', title: 'My chat', busy: false };

describe('chat webview', () => {
  before(function () {
    if (!fs.existsSync(bundle)) this.skip();
  });

  it('announces itself, shows the welcome screen and state', () => {
    const { sent, post, $ } = load();
    assert.deepStrictEqual(sent[0], { type: 'ready' });
    post({ type: 'replay', items: [], todos: [], usage: null });
    post(state);
    assert.ok($('.welcome'));
    assert.strictEqual($('#title').textContent, 'My chat');
    assert.match($('#modeBtn').textContent!, /Ask before edits/);
  });

  it('streams a conversation with thinking, tools, approvals, todos and usage', async () => {
    const { post, $, doc, sent } = load();
    post(state);
    post({ type: 'user', text: 'fix @src/a.ts please', tIndex: 0 });
    assert.ok(!$('.welcome'));
    assert.strictEqual($('.mention').textContent, '@src/a.ts');

    post({ type: 'assistantStart' });
    post({ type: 'thinking', text: 'Let me think' });
    post({ type: 'token', text: 'Here is ```ts\nconst x = 1;\n```' });
    await new Promise((r) => setTimeout(r, 80)); // streaming renders are throttled
    assert.strictEqual(($('details.thinking') as HTMLDetailsElement).open, true);
    post({ type: 'assistantEnd', text: 'Here is\n```ts\nconst x = 1;\n```', thinking: 'Let me think' });
    assert.strictEqual(($('details.thinking') as HTMLDetailsElement).open, false);
    assert.strictEqual($('.code pre code').textContent, 'const x = 1;');

    ($('[data-copy-code]') as HTMLButtonElement).click();
    assert.deepStrictEqual(sent[sent.length - 1], { type: 'copy', text: 'const x = 1;' });

    post({ type: 'toolStart', id: 't1', name: 'read_file', label: 'src/a.ts' });
    post({ type: 'toolEnd', id: 't1', ok: true, result: 'contents' });
    assert.ok($('details.tool.ok'));

    post({ type: 'approval', id: 'a1', kind: 'edit', title: 'Edit src/a.ts', detail: '+1 −1 lines' });
    ($('.approval .buttons button') as HTMLButtonElement).click();
    assert.deepStrictEqual(sent[sent.length - 1], { type: 'approve', id: 'a1', approved: true });
    post({ type: 'approvalDone', id: 'a1', approved: true });
    assert.strictEqual($('.approval .verdict').textContent, 'Approved');

    post({ type: 'todos', todos: [{ content: 'Read', status: 'completed' }, { content: 'Edit', status: 'in_progress' }] });
    assert.match($('#todos summary').textContent!, /Tasks 1\/2/);

    post({ type: 'usage', used: 9000, max: 10000 });
    assert.strictEqual($('#usage').textContent, '90%');
    assert.ok($('#usage').classList.contains('high'));

    // Edit / retry on a user message refer to its transcript index.
    (doc.querySelector('.msg.user .msg-actions button') as HTMLButtonElement).click();
    assert.deepStrictEqual(sent[sent.length - 1], { type: 'editFrom', index: 0 });
  });

  it('queues messages while busy and sends them when the agent finishes', () => {
    const { post, $, sent, w } = load();
    post(state);
    post({ type: 'busy', value: true });
    const input = $('#input') as HTMLTextAreaElement;
    input.value = 'second request';
    $('#composer').dispatchEvent(new w.Event('submit', { cancelable: true }));
    assert.match($('#queue').textContent!, /Queued: second request/);
    assert.ok(!sent.some((m) => m.type === 'send'));
    post({ type: 'busy', value: false });
    assert.deepStrictEqual(sent[sent.length - 1], { type: 'send', text: 'second request' });
    assert.ok(($('#queue') as HTMLElement).hidden);
  });

  it('suggests slash commands and @files, and cycles modes with Shift+Tab', () => {
    const { post, $, sent, w, key } = load();
    post(state);
    const input = $('#input') as HTMLTextAreaElement;

    input.value = '/com';
    input.setSelectionRange(4, 4);
    input.dispatchEvent(new w.Event('input'));
    assert.match($('#suggest').textContent!, /\/compact/);
    key(input, 'Enter');
    assert.strictEqual(input.value, '/compact ');

    input.value = 'look at @ap';
    input.setSelectionRange(11, 11);
    input.dispatchEvent(new w.Event('input'));
    assert.deepStrictEqual(sent[sent.length - 1], { type: 'mentionQuery', query: 'ap' });
    post({ type: 'mentionResults', query: 'ap', items: ['src/app.ts'] });
    key(input, 'Tab');
    assert.strictEqual(input.value, 'look at @src/app.ts ');

    key(input, 'Tab', { shiftKey: true });
    assert.deepStrictEqual(sent[sent.length - 1], { type: 'setMode', mode: 'auto' });
  });

  it('shows, filters and opens chats in the history panel', () => {
    const { post, $, sent, doc, w } = load();
    post(state);
    ($('#historyBtn') as HTMLButtonElement).click();
    assert.ok(!($('#history') as HTMLElement).hidden);
    assert.deepStrictEqual(sent[sent.length - 1], { type: 'listChats' });
    post({
      type: 'chatList',
      currentId: 'c1',
      items: [
        { id: 'c1', title: 'Login bug', when: 'just now', messageCount: 3 },
        { id: 'c2', title: 'Refactor API', when: '2 h ago', messageCount: 1 },
      ],
    });
    assert.strictEqual(doc.querySelectorAll('#historyList li').length, 2);
    const search = $('#historySearch') as HTMLInputElement;
    search.value = 'api';
    search.dispatchEvent(new w.Event('input'));
    assert.strictEqual(doc.querySelectorAll('#historyList li').length, 1);
    (doc.querySelector('#historyList li') as HTMLElement).click();
    assert.deepStrictEqual(sent[sent.length - 1], { type: 'openChat', id: 'c2' });
    assert.ok(($('#history') as HTMLElement).hidden);
  });

  it('replays a saved chat and offers to execute a plan in plan mode', () => {
    const { post, $, doc } = load();
    post({ ...state, mode: 'plan' });
    post({
      type: 'replay',
      items: [
        { type: 'user', text: 'plan it', tIndex: 0 },
        { type: 'assistantEnd', text: '1. Do A\n2. Do B', thinking: '', tIndex: 1 },
      ],
      todos: [],
      usage: { used: 100, max: 1000 },
    });
    assert.strictEqual(doc.querySelectorAll('.msg').length, 2);
    assert.strictEqual(doc.querySelectorAll('.msg.assistant ol li').length, 2);
    post({ type: 'busy', value: true });
    post({ type: 'busy', value: false });
    assert.ok($('.plan-actions'));
  });
});
