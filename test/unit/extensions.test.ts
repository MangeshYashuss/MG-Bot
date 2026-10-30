import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ToolContext } from '../../src/agent/tools/types';
import { expandSkill, loadSkills, parseSkill } from '../../src/chat/skills';
import { formatMcpResult, mcpTool, mcpToolName } from '../../src/mcp/tools';

function ctx(approved: boolean, asked: unknown[] = []): ToolContext {
  return { signal: new AbortController().signal, approve: async (req: unknown) => (asked.push(req), approved) } as unknown as ToolContext;
}

describe('skills', () => {
  it('parses frontmatter and falls back to the first line for the description', () => {
    const s = parseSkill('review', '---\ndescription: "Review the diff"\n---\nReview $ARGUMENTS carefully.\n');
    assert.deepStrictEqual(s, { name: 'review', description: 'Review the diff', prompt: 'Review $ARGUMENTS carefully.' });
    assert.strictEqual(parseSkill('t', '# Write tests\nCover edge cases.').description, 'Write tests');
  });

  it('fills $ARGUMENTS or appends the arguments', () => {
    assert.strictEqual(expandSkill(parseSkill('a', 'Fix $ARGUMENTS now'), 'the login bug'), 'Fix the login bug now');
    assert.strictEqual(expandSkill(parseSkill('a', 'Explain this.'), 'src/a.ts'), 'Explain this.\n\nsrc/a.ts');
    assert.strictEqual(expandSkill(parseSkill('a', 'Explain this.'), ''), 'Explain this.');
  });

  it('loads skills from folders; built-ins and earlier folders win clashes', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mgbot-skills-'));
    const [project, global] = [path.join(tmp, 'p'), path.join(tmp, 'g')];
    fs.mkdirSync(project);
    fs.mkdirSync(global);
    fs.writeFileSync(path.join(project, 'Review.md'), 'Project review');
    fs.writeFileSync(path.join(project, 'help.md'), 'Shadows a built-in');
    fs.writeFileSync(path.join(project, 'notes.txt'), 'ignored');
    fs.writeFileSync(path.join(global, 'review.md'), 'Global review');
    fs.writeFileSync(path.join(global, 'write tests.md'), 'Write tests');
    const skills = await loadSkills([project, path.join(tmp, 'missing'), global], ['help']);
    assert.deepStrictEqual(skills.map((s) => [s.name, s.prompt]), [['review', 'Project review'], ['write-tests', 'Write tests']]);
  });
});

describe('MCP tools', () => {
  const info = { name: 'create issue', description: 'Create an issue', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } };

  it('names, describes and formats results', () => {
    assert.strictEqual(mcpToolName('git hub', 'create.issue'), 'git_hub__create_issue');
    assert.strictEqual(mcpToolName('s', 'x'.repeat(100)).length, 64);
    assert.strictEqual(formatMcpResult({ content: [{ type: 'text', text: 'a' }, { type: 'image' }] }), 'a\n[image content not shown]');
    assert.strictEqual(formatMcpResult({ structuredContent: { n: 1 } }), '{\n  "n": 1\n}');
  });

  it('asks for approval unless the tool is read-only or auto-approved', async () => {
    const calls: unknown[] = [];
    const call = async (name: string, args: Record<string, unknown>) => (calls.push([name, args]), { content: [{ type: 'text', text: 'done' }] });
    const asked: unknown[] = [];
    const tool = mcpTool('github', {}, info, call);
    assert.strictEqual(tool.spec.name, 'github__create_issue');
    assert.strictEqual(tool.readOnly, false);
    assert.match(await tool.run({ title: 'x' }, ctx(false, asked)), /declined/);
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(await tool.run({ title: 'x' }, ctx(true, asked)), 'done');
    assert.deepStrictEqual(calls, [['create issue', { title: 'x' }]]);
    assert.strictEqual(asked.length, 2);

    const silent: unknown[] = [];
    await mcpTool('github', { autoApprove: ['create issue'] }, info, call).run({}, ctx(false, silent));
    await mcpTool('github', {}, { ...info, annotations: { readOnlyHint: true } }, call).run({}, ctx(false, silent));
    assert.strictEqual(silent.length, 0);
  });

  it('turns tool errors into failures', async () => {
    const tool = mcpTool('s', { autoApprove: true }, info, async () => ({ isError: true, content: [{ type: 'text', text: 'bad title' }] }));
    await assert.rejects(tool.run({}, ctx(true)), /bad title/);
  });

  it('works against a real stdio MCP server', async function () {
    this.timeout(20_000);
    const server = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mgbot-mcp-')), 'server.js');
    const sdk = path.dirname(require.resolve('@modelcontextprotocol/sdk/server/index.js')).replace(/\\/g, '/');
    fs.writeFileSync(
      server,
      `const { Server } = require('${sdk}/index.js');
const { StdioServerTransport } = require('${sdk}/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('${sdk}/../types.js');
const s = new Server({ name: 'echo', version: '1' }, { capabilities: { tools: {} } });
s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, annotations: { readOnlyHint: true } }] }));
s.setRequestHandler(CallToolRequestSchema, async (r) => ({ content: [{ type: 'text', text: 'echo: ' + r.params.arguments.text }] }));
s.connect(new StdioServerTransport());`,
    );
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [server] }));
    try {
      const { tools } = await client.listTools();
      const tool = mcpTool('echo', {}, tools[0] as any, (name, args, signal) => client.callTool({ name, arguments: args }, undefined, { signal }) as any);
      assert.strictEqual(tool.readOnly, true);
      assert.strictEqual(await tool.run({ text: 'hi' }, ctx(false)), 'echo: hi');
    } finally {
      await client.close();
    }
  });
});
