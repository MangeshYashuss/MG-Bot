import * as assert from 'assert';
import * as http from 'http';
import { AddressInfo } from 'net';
import { OllamaProvider } from '../../src/providers/ollama';
import { OpenAICompatProvider } from '../../src/providers/openaiCompat';
import { ToolsUnsupportedError } from '../../src/providers/types';

type Handler = (req: http.IncomingMessage, body: any, res: http.ServerResponse) => void;

/** Starts a throwaway HTTP server that replays canned runtime responses. */
async function mockServer(handler: Handler): Promise<{ url: string; close: () => void; requests: any[] }> {
  const requests: any[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ url: req.url, method: req.method, body });
      handler(req, body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close(), requests };
}

describe('OllamaProvider', () => {
  it('streams content and native tool calls, sending num_ctx and tools', async () => {
    const srv = await mockServer((req, _body, res) => {
      assert.strictEqual(req.url, '/api/chat');
      res.write(JSON.stringify({ message: { content: 'Hel' } }) + '\n');
      // Split one JSON line across two network chunks to exercise the line buffer.
      const line = JSON.stringify({ message: { content: 'lo', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.ts' } } }] } }) + '\n';
      res.write(line.slice(0, 10));
      setTimeout(() => res.end(line.slice(10) + JSON.stringify({ done: true }) + '\n'), 10);
    });
    try {
      const tokens: string[] = [];
      const p = new OllamaProvider(srv.url);
      const out = await p.chat({
        model: 'm',
        contextSize: 8192,
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'read_file', description: 'd', parameters: {} }],
        onToken: (t) => tokens.push(t),
      });
      assert.strictEqual(out.content, 'Hello');
      assert.deepStrictEqual(tokens, ['Hel', 'lo']);
      assert.strictEqual(out.toolCalls[0].name, 'read_file');
      assert.deepStrictEqual(out.toolCalls[0].arguments, { path: 'a.ts' });
      assert.strictEqual(srv.requests[0].body.options.num_ctx, 8192);
      assert.strictEqual(srv.requests[0].body.tools[0].function.name, 'read_file');
    } finally {
      srv.close();
    }
  });

  it('maps "does not support tools" to ToolsUnsupportedError', async () => {
    const srv = await mockServer((_req, _body, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'registry.ollama.ai/library/x does not support tools' }));
    });
    try {
      await assert.rejects(
        new OllamaProvider(srv.url).chat({ model: 'x', messages: [], tools: [{ name: 't', description: '', parameters: {} }] }),
        ToolsUnsupportedError,
      );
    } finally {
      srv.close();
    }
  });

  it('reports pull progress, lists models and reads context length', async () => {
    const srv = await mockServer((req, _body, res) => {
      if (req.url === '/api/pull') {
        res.write(JSON.stringify({ status: 'pulling', completed: 5, total: 10 }) + '\n');
        res.end(JSON.stringify({ status: 'success' }) + '\n');
      } else if (req.url === '/api/tags') {
        res.end(JSON.stringify({ models: [{ name: 'a:7b', size: 100, details: { parameter_size: '7B' } }] }));
      } else if (req.url === '/api/show') {
        res.end(JSON.stringify({ model_info: { 'qwen2.context_length': 32768 } }));
      }
    });
    try {
      const p = new OllamaProvider(srv.url);
      const progress: string[] = [];
      await p.pullModel('a:7b', (x) => progress.push(`${x.status}:${x.completed ?? ''}`));
      assert.deepStrictEqual(progress, ['pulling:5', 'success:']);
      assert.deepStrictEqual(await p.listModels(), [{ name: 'a:7b', sizeBytes: 100, parameterSize: '7B', family: undefined, remote: false }]);
      assert.strictEqual(await p.contextLength('a:7b'), 32768);
    } finally {
      srv.close();
    }
  });
});

describe('OpenAICompatProvider', () => {
  it('assembles streamed SSE content and fragmented tool-call arguments', async () => {
    const srv = await mockServer((req, _body, res) => {
      assert.strictEqual(req.url, '/v1/chat/completions');
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      send({ choices: [{ delta: { content: 'Look' } }] });
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"pa' } }] } }] });
      send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"b.ts"}' } }] } }] });
      res.end('data: [DONE]\n\n');
    });
    try {
      const p = new OpenAICompatProvider(srv.url); // "/v1" is appended automatically
      const out = await p.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], tools: [{ name: 'read_file', description: '', parameters: {} }] });
      assert.strictEqual(out.content, 'Look');
      assert.deepStrictEqual(out.toolCalls, [{ id: 'c1', name: 'read_file', arguments: { path: 'b.ts' } }]);
    } finally {
      srv.close();
    }
  });

  it('serializes tool turns in OpenAI format and orders embeddings by index', async () => {
    const srv = await mockServer((req, _body, res) => {
      if (req.url === '/v1/embeddings') {
        res.end(JSON.stringify({ data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }] }));
      } else {
        res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
      }
    });
    try {
      const p = new OpenAICompatProvider(srv.url + '/v1/');
      assert.deepStrictEqual(await p.embed('e', ['a', 'b']), [[1], [2]]);
      await p.chat({
        model: 'm',
        messages: [
          { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 't', arguments: { a: 1 } }] },
          { role: 'tool', toolCallId: 'c1', name: 't', content: 'res' },
        ],
      });
      const sent = srv.requests[1].body.messages;
      assert.strictEqual(sent[0].tool_calls[0].function.arguments, '{"a":1}');
      assert.deepStrictEqual(sent[1], { role: 'tool', tool_call_id: 'c1', content: 'res' });
    } finally {
      srv.close();
    }
  });
});
