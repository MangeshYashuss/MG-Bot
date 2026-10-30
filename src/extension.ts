import * as path from 'path';
import * as vscode from 'vscode';
import { Agent } from './agent/loop';
import { CommandRunner } from './agent/tools/commandTool';
import { PROPOSED_SCHEME, proposedContent } from './agent/tools/editTools';
import { SKILL_TEMPLATE } from './chat/skills';
import { ChatStore } from './chat/store';
import { ProviderHolder, workspaceRoots } from './config';
import { McpManager } from './mcp/manager';
import { CodeIndexer } from './memory/indexer';
import { ProjectNotes } from './memory/notes';
import { ModelManager } from './models/manager';
import { ChatViewProvider, globalSkillsDir } from './webview/chatProvider';

type ModelNode = { model?: { name: string }; entry?: { name: string } } | undefined;
const nodeName = (n: ModelNode) => n?.model?.name ?? n?.entry?.name;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const providers = new ProviderHolder();
  const notes = new ProjectNotes(providers);
  const indexer = new CodeIndexer(providers);
  const commands = new CommandRunner();
  const models = new ModelManager(providers);
  const mcp = new McpManager();
  const agent = new Agent({ providers, notes, indexer, commands, mcp });
  // Chats live in VS Code's per-workspace storage, so each project has its own history.
  const storageRoot = context.storageUri ?? vscode.Uri.joinPath(context.globalStorageUri, 'no-workspace');
  const store = new ChatStore(path.join(storageRoot.fsPath, 'chats'));
  const chat = new ChatViewProvider(context.extensionUri, context.workspaceState, store, agent, models, mcp);
  await chat.restoreLastChat();

  context.subscriptions.push(
    indexer,
    commands,
    mcp,
    chat,
    vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, proposedContent),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, chat, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerTreeDataProvider('mgbot.models', models),

    vscode.commands.registerCommand('mgbot.openChat', () => vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`)),
    vscode.commands.registerCommand('mgbot.newChat', () => chat.newChat()),
    vscode.commands.registerCommand('mgbot.showHistory', () => chat.showHistoryPicker()),
    vscode.commands.registerCommand('mgbot.refreshModels', () => models.refresh()),
    vscode.commands.registerCommand('mgbot.selectRuntime', () => models.selectRuntime()),
    vscode.commands.registerCommand('mgbot.pullModel', () => models.promptDownload()),
    vscode.commands.registerCommand('mgbot.downloadModel', (n: ModelNode) => nodeName(n) && models.download(nodeName(n)!)),
    vscode.commands.registerCommand('mgbot.deleteModel', (n: ModelNode) => nodeName(n) && models.delete(nodeName(n)!)),
    vscode.commands.registerCommand('mgbot.setChatModel', (n: ModelNode) => nodeName(n) && models.setChatModel(nodeName(n)!)),
    vscode.commands.registerCommand('mgbot.setEmbeddingModel', (n: ModelNode) => nodeName(n) && models.setEmbeddingModel(nodeName(n)!)),
    vscode.commands.registerCommand('mgbot.installHelp', () => vscode.env.openExternal(vscode.Uri.parse('https://ollama.com/download'))),
    vscode.commands.registerCommand('mgbot.syncIndex', () => indexer.sync(false)),
    vscode.commands.registerCommand('mgbot.rebuildIndex', async () => {
      const ok = await vscode.window.showInformationMessage('Re-embed the whole workspace from scratch?', { modal: true }, 'Rebuild');
      if (ok === 'Rebuild') await indexer.sync(true);
    }),
    vscode.commands.registerCommand('mgbot.openMemory', async () => {
      const uri = await notes.ensureExists();
      if (uri) await vscode.window.showTextDocument(uri);
      else vscode.window.showWarningMessage('Open a folder first — project memory is stored inside it.');
    }),
    vscode.commands.registerCommand('mgbot.newSkill', async () => {
      const name = await vscode.window.showInputBox({
        prompt: 'Skill name — you will run it as /name',
        placeHolder: 'e.g. review, write-tests',
        validateInput: (v) => (/^[\w-]+$/.test(v) ? undefined : 'Use letters, numbers, - and _ only.'),
      });
      if (!name) return;
      const root = workspaceRoots()[0];
      const dir = root ? path.join(root.fsPath, '.mgbot', 'skills') : globalSkillsDir();
      const uri = vscode.Uri.file(path.join(dir, `${name.toLowerCase()}.md`));
      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(SKILL_TEMPLATE, 'utf8'));
      }
      await vscode.window.showTextDocument(uri);
    }),
    vscode.commands.registerCommand('mgbot.openMcpSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', 'mgbot.mcpServers')),
    vscode.commands.registerCommand('mgbot.explainSelection', () => askAboutSelection(chat, 'Explain what this code does, step by step, and point out anything risky.')),
    vscode.commands.registerCommand('mgbot.refactorSelection', async () => {
      const goal = await vscode.window.showInputBox({ prompt: 'How should the selection be refactored?', placeHolder: 'e.g. extract a helper, add types, simplify' });
      if (goal) await askAboutSelection(chat, `Refactor the selected code: ${goal}. Apply the change with edit_file.`);
    }),

    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration('mgbot.provider') || e.affectsConfiguration('mgbot.endpoint')) await models.refresh();
      if (e.affectsConfiguration('mgbot.chatModel')) chat.postState();
      if (e.affectsConfiguration('mgbot.embeddingModel') || e.affectsConfiguration('mgbot.index')) await indexer.sync(false);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => indexer.sync(false)),
  );

  await models.refresh();
  void indexer.start();
}

async function askAboutSelection(chat: ChatViewProvider, instruction: string): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    vscode.window.showInformationMessage('Select some code first.');
    return;
  }
  const rel = vscode.workspace.asRelativePath(editor.document.uri);
  const { start, end } = editor.selection;
  await chat.send(`${instruction}\n\nSelection: ${rel}:${start.line + 1}-${end.line + 1}`);
}

export function deactivate(): void {}
