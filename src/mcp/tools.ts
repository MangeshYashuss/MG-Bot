import type { Tool } from '../agent/tools/types';

/** One entry of `mgbot.mcpServers` (same shape other MCP clients use). */
export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** Tools that run without asking: `true` for all, or a list of tool names. */
  autoApprove?: boolean | string[];
  disabled?: boolean;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
}

export interface McpCallResult {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

export type McpCall = (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<McpCallResult>;

/** Tool names must match ^[a-zA-Z0-9_-]{1,64}$ for most runtimes. */
export function mcpToolName(server: string, tool: string): string {
  return `${server}__${tool}`.replace(/[^\w-]/g, '_').slice(0, 64);
}

export function formatMcpResult(res: McpCallResult): string {
  const parts = (res.content ?? []).map((c) => (c.type === 'text' ? c.text ?? '' : `[${c.type} content not shown]`));
  if (!parts.length && res.structuredContent !== undefined) parts.push(JSON.stringify(res.structuredContent, null, 2));
  return parts.join('\n').trim();
}

/** Wraps an MCP server tool as an agent tool. Calls ask for approval unless the tool is read-only or auto-approved. */
export function mcpTool(server: string, cfg: McpServerConfig, info: McpToolInfo, call: McpCall): Tool {
  const readOnly = !!info.annotations?.readOnlyHint;
  const trusted = readOnly || cfg.autoApprove === true || (Array.isArray(cfg.autoApprove) && cfg.autoApprove.includes(info.name));
  return {
    spec: {
      name: mcpToolName(server, info.name),
      description: `[MCP: ${server}] ${info.description ?? info.name}`,
      parameters: info.inputSchema?.type ? info.inputSchema : { type: 'object', properties: {} },
    },
    readOnly,
    label: (args) => JSON.stringify(args ?? {}),
    async run(args, ctx) {
      if (!trusted) {
        const ok = await ctx.approve({ kind: 'tool', title: `Allow ${server} → ${info.name}`, detail: JSON.stringify(args ?? {}, null, 2) });
        if (!ok) return 'The user declined this tool call. Do not retry it; ask the user or continue without it.';
      }
      const res = await call(info.name, args ?? {}, ctx.signal);
      const text = formatMcpResult(res);
      if (res.isError) throw new Error(text || 'The MCP tool reported an error.');
      return text || '(no output)';
    },
  };
}
