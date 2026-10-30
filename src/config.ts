import * as vscode from 'vscode';
import type { McpServerConfig } from './mcp/tools';
import { createProvider, ModelProvider } from './providers';

export interface MgBotConfig {
  provider: 'ollama' | 'openai-compatible';
  endpoint: string;
  chatModel: string;
  embeddingModel: string;
  contextSize: number;
  maxSteps: number;
  autoApproveEdits: boolean;
  commandAllowList: string[];
  commandTimeoutSeconds: number;
  indexEnabled: boolean;
  indexExclude: string[];
  indexMaxFileSizeKB: number;
  mcpServers: Record<string, McpServerConfig>;
}

export function getConfig(): MgBotConfig {
  const c = vscode.workspace.getConfiguration('mgbot');
  return {
    provider: c.get('provider', 'ollama'),
    endpoint: c.get('endpoint', ''),
    chatModel: c.get('chatModel', ''),
    embeddingModel: c.get('embeddingModel', ''),
    contextSize: c.get('contextSize', 16384),
    maxSteps: c.get('maxSteps', 25),
    autoApproveEdits: c.get('autoApproveEdits', false),
    commandAllowList: c.get('commandAllowList', []),
    commandTimeoutSeconds: c.get('commandTimeoutSeconds', 120),
    indexEnabled: c.get('index.enabled', true),
    indexExclude: c.get('index.exclude', []),
    indexMaxFileSizeKB: c.get('index.maxFileSizeKB', 256),
    mcpServers: c.get('mcpServers', {}),
  };
}

export async function updateSetting(key: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration('mgbot').update(key, value, vscode.ConfigurationTarget.Global);
}

/** Returns a provider matching the current settings, recreated only when they change. */
export class ProviderHolder {
  private current?: ModelProvider;
  private key = '';

  get(): ModelProvider {
    const cfg = getConfig();
    const key = `${cfg.provider}|${cfg.endpoint}`;
    if (!this.current || key !== this.key) {
      this.current = createProvider(cfg.provider, cfg.endpoint);
      this.key = key;
    }
    return this.current;
  }
}

export function workspaceRoots(): { name: string; fsPath: string }[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => ({ name: f.name, fsPath: f.uri.fsPath }));
}
