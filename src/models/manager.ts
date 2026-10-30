import * as vscode from 'vscode';
import { ProviderHolder, getConfig, updateSetting } from '../config';
import { OLLAMA_DEFAULT_ENDPOINT } from '../providers/ollama';
import { OPENAI_COMPAT_DEFAULT_ENDPOINT } from '../providers/openaiCompat';
import { ModelInfo } from '../providers/types';
import catalog from './catalog.json';

interface CatalogEntry {
  name: string;
  kind: 'chat' | 'embedding';
  size: string;
  ram: string;
  note: string;
}

type Node =
  | { type: 'group'; id: 'installed' | 'catalog' }
  | { type: 'installed'; model: ModelInfo }
  | { type: 'catalog'; entry: CatalogEntry }
  | { type: 'message'; text: string; tooltip?: string; command?: vscode.Command; icon?: string };

const CATALOG = catalog as CatalogEntry[];

/** Tree view listing installed models and a curated download catalog. */
export class ModelManager implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private installed: ModelInfo[] = [];
  private healthy = false;
  private readonly downloading = new Set<string>();

  /** Fires after the model list or selection changes so the chat view can update. */
  readonly onDidChangeModels = new vscode.EventEmitter<void>();

  constructor(private readonly providers: ProviderHolder) {}

  get models(): ModelInfo[] {
    return this.installed;
  }

  get isHealthy(): boolean {
    return this.healthy;
  }

  async refresh(): Promise<void> {
    const provider = this.providers.get();
    this.healthy = await provider.health();
    this.installed = this.healthy ? await provider.listModels().catch(() => []) : [];
    this.changed.fire();
    this.onDidChangeModels.fire();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const cfg = getConfig();
    switch (node.type) {
      case 'group': {
        const label = node.id === 'installed' ? 'Installed' : 'Download';
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon(node.id === 'installed' ? 'library' : 'cloud-download');
        return item;
      }
      case 'installed': {
        const m = node.model;
        const item = new vscode.TreeItem(m.name);
        const roles = [m.name === cfg.chatModel && 'chat', m.name === cfg.embeddingModel && 'embeddings'].filter(Boolean);
        item.description = [roles.length ? `✓ ${roles.join(' + ')}` : '', m.parameterSize, m.sizeBytes ? formatBytes(m.sizeBytes) : '', m.remote ? 'cloud' : '']
          .filter(Boolean)
          .join(' · ');
        item.tooltip = m.remote ? `${m.name}\nCloud model: prompts are sent to a remote server, not run locally.` : m.name;
        item.iconPath = new vscode.ThemeIcon(roles.length ? 'pass-filled' : m.remote ? 'cloud' : 'circuit-board');
        item.contextValue = this.providers.get().canManageModels ? 'installedModel.deletable' : 'installedModel';
        return item;
      }
      case 'catalog': {
        const e = node.entry;
        const busy = this.downloading.has(e.name);
        const item = new vscode.TreeItem(e.name);
        item.description = busy ? 'downloading…' : `${e.kind === 'embedding' ? 'embeddings · ' : ''}${e.size} · ${e.ram} RAM`;
        item.tooltip = new vscode.MarkdownString(`**${e.name}**\n\n${e.note}\n\nDownload: ${e.size} · Needs about ${e.ram} memory`);
        item.iconPath = new vscode.ThemeIcon(busy ? 'sync~spin' : e.kind === 'embedding' ? 'database' : 'cloud-download');
        item.contextValue = busy ? 'catalogModel.busy' : 'catalogModel';
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(node.text);
        item.tooltip = node.tooltip;
        item.command = node.command;
        item.iconPath = new vscode.ThemeIcon(node.icon ?? 'info');
        return item;
      }
    }
  }

  getChildren(node?: Node): Node[] {
    const provider = this.providers.get();
    if (!node) {
      if (!this.healthy) {
        const ollama = provider.id === 'ollama';
        return [
          {
            type: 'message',
            text: `Can't reach ${ollama ? 'Ollama' : 'the model server'} at ${provider.endpoint}`,
            icon: 'warning',
            tooltip: ollama ? 'Install and start Ollama, then click Retry.' : 'Start your local server (LM Studio, llama.cpp…) or change mgbot.endpoint.',
          },
          ...(ollama
            ? [{ type: 'message' as const, text: 'Install Ollama…', icon: 'link-external', command: { command: 'mgbot.installHelp', title: 'Install' } }]
            : []),
          { type: 'message', text: 'Retry', icon: 'refresh', command: { command: 'mgbot.refreshModels', title: 'Retry' } },
          { type: 'message', text: 'Use a different runtime…', icon: 'server-environment', command: { command: 'mgbot.selectRuntime', title: 'Runtime' } },
        ];
      }
      return provider.canManageModels ? [{ type: 'group', id: 'installed' }, { type: 'group', id: 'catalog' }] : [{ type: 'group', id: 'installed' }];
    }
    if (node.type !== 'group') return [];
    if (node.id === 'installed') {
      if (!this.installed.length) {
        return [{ type: 'message', text: provider.canManageModels ? 'No models yet — download one below' : 'No models loaded in the server' }];
      }
      return this.installed.map((model) => ({ type: 'installed', model }));
    }
    const have = new Set(this.installed.map((m) => m.name.replace(/:latest$/, '')));
    return CATALOG.filter((e) => !have.has(e.name.replace(/:latest$/, ''))).map((entry) => ({ type: 'catalog', entry }));
  }

  async download(name: string): Promise<void> {
    const provider = this.providers.get();
    if (!provider.canManageModels) {
      vscode.window.showWarningMessage('This runtime cannot download models from VS Code. Download it in the runtime itself, then click Refresh.');
      return;
    }
    if (this.downloading.has(name)) return;
    this.downloading.add(name);
    this.changed.fire();
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Downloading ${name}`, cancellable: true },
        async (progress, token) => {
          const abort = new AbortController();
          token.onCancellationRequested(() => abort.abort());
          let lastPct = 0;
          await provider.pullModel(
            name,
            (p) => {
              if (p.total && p.completed !== undefined) {
                const pct = Math.floor((p.completed / p.total) * 100);
                progress.report({ message: `${p.status} ${formatBytes(p.completed)} / ${formatBytes(p.total)}`, increment: pct - lastPct });
                lastPct = pct;
              } else {
                progress.report({ message: p.status });
              }
            },
            abort.signal,
          );
        },
      );
      await this.refresh();
      const entry = CATALOG.find((e) => e.name === name);
      const cfg = getConfig();
      if (entry?.kind === 'embedding' && !cfg.embeddingModel) await this.setEmbeddingModel(name);
      else if (entry?.kind !== 'embedding' && !cfg.chatModel) await this.setChatModel(name);
      vscode.window.showInformationMessage(`${name} is ready.`);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') vscode.window.showErrorMessage(`Download of ${name} failed: ${(err as Error).message}`);
    } finally {
      this.downloading.delete(name);
      this.changed.fire();
    }
  }

  async promptDownload(): Promise<void> {
    const name = await vscode.window.showInputBox({
      title: 'Download a model',
      prompt: 'Any model name from ollama.com/library, e.g. qwen2.5-coder:7b or hf.co/<user>/<repo>-GGUF',
      placeHolder: 'qwen2.5-coder:7b',
    });
    if (name?.trim()) await this.download(name.trim());
  }

  async delete(name: string): Promise<void> {
    const ok = await vscode.window.showWarningMessage(`Delete ${name} from this computer?`, { modal: true }, 'Delete');
    if (ok !== 'Delete') return;
    try {
      await this.providers.get().deleteModel(name);
      const cfg = getConfig();
      if (cfg.chatModel === name) await updateSetting('chatModel', '');
      if (cfg.embeddingModel === name) await updateSetting('embeddingModel', '');
      await this.refresh();
    } catch (err) {
      vscode.window.showErrorMessage(`Could not delete ${name}: ${(err as Error).message}`);
    }
  }

  async setChatModel(name: string): Promise<void> {
    await updateSetting('chatModel', name);
    this.changed.fire();
    this.onDidChangeModels.fire();
  }

  async setEmbeddingModel(name: string): Promise<void> {
    await updateSetting('embeddingModel', name);
    this.changed.fire();
    this.onDidChangeModels.fire();
  }

  async selectRuntime(): Promise<void> {
    const pick = await vscode.window.showQuickPick(
      [
        { label: 'Ollama', description: OLLAMA_DEFAULT_ENDPOINT, provider: 'ollama', endpoint: '' },
        { label: 'LM Studio', description: 'http://localhost:1234/v1', provider: 'openai-compatible', endpoint: OPENAI_COMPAT_DEFAULT_ENDPOINT },
        { label: 'llama.cpp server', description: 'http://localhost:8080/v1', provider: 'openai-compatible', endpoint: 'http://localhost:8080/v1' },
        { label: 'Custom OpenAI-compatible URL…', description: 'vLLM, LocalAI, Jan, …', provider: 'openai-compatible', endpoint: '?' },
      ],
      { title: 'Choose the local model runtime' },
    );
    if (!pick) return;
    let endpoint = pick.endpoint;
    if (endpoint === '?') {
      const input = await vscode.window.showInputBox({ prompt: 'Base URL of the OpenAI-compatible server', value: 'http://localhost:8000/v1' });
      if (!input) return;
      endpoint = input.trim();
    }
    await updateSetting('provider', pick.provider);
    await updateSetting('endpoint', endpoint);
    await this.refresh();
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = -1;
  do {
    v /= 1024;
    u++;
  } while (v >= 1024 && u < units.length - 1);
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[u]}`;
}
