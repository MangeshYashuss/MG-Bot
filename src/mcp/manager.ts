import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as vscode from 'vscode';
import type { Tool } from '../agent/tools/types';
import { getConfig, workspaceRoots } from '../config';
import { McpServerConfig, McpToolInfo, mcpTool } from './tools';

const CONNECT_TIMEOUT_MS = 30_000;

interface Server {
  name: string;
  client?: Client;
  tools: Tool[];
  error?: string;
}

/**
 * Connects to the servers in `mgbot.mcpServers` on first use (not at startup, so no processes
 * are spawned until the agent runs) and reconnects whenever the setting changes.
 */
export class McpManager implements vscode.Disposable {
  private servers: Promise<Server[]> = Promise.resolve([]);
  private key = '';

  private connect(): Promise<Server[]> {
    const configs = getConfig().mcpServers;
    const key = JSON.stringify(configs);
    if (key !== this.key) {
      this.key = key;
      void this.servers.then(closeAll);
      this.servers = Promise.all(
        Object.entries(configs)
          .filter(([, c]) => !c.disabled)
          .map(([name, c]) => connectServer(name, c)),
      );
    }
    return this.servers;
  }

  async tools(): Promise<Tool[]> {
    return (await this.connect()).flatMap((s) => s.tools);
  }

  /** Markdown-ish status for the /mcp command. */
  async status(): Promise<string> {
    const servers = await this.connect();
    if (!servers.length) {
      return 'No MCP servers configured. Add them to the "mgbot.mcpServers" setting, e.g.\n{ "fetch": { "command": "uvx", "args": ["mcp-server-fetch"] } }';
    }
    return servers
      .map((s) => (s.error ? `✕ ${s.name}: ${s.error}` : `✓ ${s.name}: ${s.tools.map((t) => t.spec.name).join(', ') || 'no tools'}`))
      .join('\n');
  }

  dispose(): void {
    void this.servers.then(closeAll);
  }
}

async function connectServer(name: string, cfg: McpServerConfig): Promise<Server> {
  const client = new Client({ name: 'mg-bot', version: '0.2.0' });
  try {
    if (!cfg.url && !cfg.command) throw new Error('needs a "command" (stdio) or a "url" (HTTP).');
    const transport = cfg.url
      ? new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } })
      : new StdioClientTransport({ command: cfg.command!, args: cfg.args ?? [], env: cfg.env, cwd: cfg.cwd ?? workspaceRoots()[0]?.fsPath });
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    const infos: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: CONNECT_TIMEOUT_MS });
      infos.push(...(page.tools as McpToolInfo[]));
      cursor = page.nextCursor;
    } while (cursor);
    const call = (tool: string, args: Record<string, unknown>, signal: AbortSignal) =>
      client.callTool({ name: tool, arguments: args }, undefined, { signal, timeout: getConfig().commandTimeoutSeconds * 1000 }) as Promise<any>;
    return { name, client, tools: infos.map((info) => mcpTool(name, cfg, info, call)) };
  } catch (err) {
    const error = (err as Error).message;
    void client.close().catch(() => undefined);
    vscode.window.showWarningMessage(`MG Bot: MCP server "${name}" failed to start — ${error}`);
    return { name, tools: [], error };
  }
}

async function closeAll(servers: Server[]): Promise<void> {
  await Promise.all(servers.map((s) => s.client?.close().catch(() => undefined)));
}
