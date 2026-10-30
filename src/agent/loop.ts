import * as vscode from 'vscode';
import { AgentMode, Todo } from '../chat/store';
import { COMPACT_PROMPT, splitThinking } from '../chat/text';
import { ProviderHolder, getConfig } from '../config';
import { CodeIndexer } from '../memory/indexer';
import { ProjectNotes } from '../memory/notes';
import { SearchHit } from '../memory/vectorStore';
import { fallbackToolInstructions, parseFallbackToolCalls, toFallbackMessages } from '../providers/toolFallback';
import { ChatMessage, ToolsUnsupportedError } from '../providers/types';
import { estimateTokens, fitToBudget, messagesTokens } from './context';
import { PromptParts, buildSystemPrompt } from './prompt';
import { CommandRunner } from './tools/commandTool';
import { ALL_TOOLS, TOOLS_BY_NAME } from './tools';
import { ApprovalRequest } from './tools/types';

const MAX_TOOL_RESULT = 12_000;
const RESPONSE_RESERVE = 2048;

export interface AgentEvents {
  onAssistantStart(): void;
  onToken(text: string): void;
  onThinking(text: string): void;
  onAssistantEnd(content: string, thinking: string): void;
  onToolStart(id: string, name: string, label: string): void;
  onToolEnd(id: string, ok: boolean, result: string): void;
  onNotice(text: string): void;
  onTodos(todos: Todo[]): void;
  onUsage(used: number, max: number): void;
  approve(req: ApprovalRequest): Promise<boolean>;
}

export interface AgentDeps {
  providers: ProviderHolder;
  notes: ProjectNotes;
  indexer: CodeIndexer;
  commands: CommandRunner;
}

/** The parts of a chat session the agent reads and updates. */
export interface AgentSession {
  history: ChatMessage[];
  todos: Todo[];
}

export interface RunOptions {
  mode: AgentMode;
  includeEditor: boolean;
}

export class Agent {
  /** Models that rejected native tool calling; they use the text protocol instead. */
  private readonly fallbackModels = new Set<string>();
  private readonly contextCache = new Map<string, number | undefined>();

  constructor(private readonly deps: AgentDeps) {}

  async run(session: AgentSession, userContent: string, opts: RunOptions, events: AgentEvents, signal: AbortSignal): Promise<void> {
    const cfg = getConfig();
    const provider = this.deps.providers.get();
    const model = this.requireModel();

    const contextSize = await this.contextSize(model);
    session.history.push({ role: 'user', content: userContent });

    const [memory, relevantCode] = await Promise.all([
      this.deps.notes.forPrompt(signal).catch(() => ''),
      this.relevantCode(userContent),
    ]);
    const parts: PromptParts = {
      workspaceNames: (vscode.workspace.workspaceFolders ?? []).map((f) => f.name),
      memory,
      relevantCode,
      editor: opts.includeEditor ? editorContext() : undefined,
      mode: opts.mode,
      todos: session.todos,
    };
    const tools = opts.mode === 'plan' ? ALL_TOOLS.filter((t) => t.readOnly) : ALL_TOOLS;
    const toolNames = new Set(tools.map((t) => t.spec.name));
    const toolSpecs = tools.map((t) => t.spec);

    for (let step = 0; step < cfg.maxSteps; step++) {
      const fallback = this.fallbackModels.has(model);
      const system = buildSystemPrompt({ ...parts, todos: session.todos, fallbackTools: fallback ? fallbackToolInstructions(toolSpecs) : undefined });
      const budget = Math.max(1024, contextSize - estimateTokens(system) - RESPONSE_RESERVE);
      let messages = fitToBudget(session.history, budget);
      if (fallback) messages = toFallbackMessages(messages);
      events.onUsage(estimateTokens(system) + messagesTokens(messages), contextSize);

      events.onAssistantStart();
      let result;
      try {
        result = await provider.chat({
          model,
          contextSize,
          signal,
          messages: [{ role: 'system', content: system }, ...messages],
          tools: fallback ? undefined : toolSpecs,
          onToken: (t) => events.onToken(t),
          onThinking: (t) => events.onThinking(t),
        });
      } catch (err) {
        if (err instanceof ToolsUnsupportedError) {
          this.fallbackModels.add(model);
          events.onAssistantEnd('', '');
          events.onNotice(`${model} has no native tool calling — switching to text-based tool calls.`);
          step--;
          continue;
        }
        throw err;
      }
      if (result.usage?.promptTokens) events.onUsage(result.usage.promptTokens + (result.usage.completionTokens ?? 0), contextSize);

      // Some models write their reasoning inline as <think>…</think>.
      const split = splitThinking(result.content);
      let content = split.content;
      const thinking = [result.thinking, split.thinking].filter(Boolean).join('\n\n');
      let toolCalls = result.toolCalls;
      if (!toolCalls.length) {
        // Also catches models that write tool calls as text even when native tools were offered.
        const parsed = parseFallbackToolCalls(content, toolNames);
        if (parsed.toolCalls.length) ({ content, toolCalls } = parsed);
      }
      session.history.push({ role: 'assistant', content, toolCalls: toolCalls.length ? toolCalls : undefined });
      events.onAssistantEnd(content, thinking);
      if (!toolCalls.length) return;

      for (const call of toolCalls) {
        const tool = toolNames.has(call.name) ? TOOLS_BY_NAME.get(call.name) : undefined;
        let output: string;
        let ok = true;
        if (signal.aborted) {
          output = 'Cancelled by the user.';
          ok = false;
        } else if (!tool) {
          ok = false;
          output =
            opts.mode === 'plan' && TOOLS_BY_NAME.has(call.name)
              ? `${call.name} is not available in plan mode. Finish the plan; the user will switch modes to carry it out.`
              : `Unknown tool "${call.name}". Available tools: ${[...toolNames].join(', ')}.`;
          events.onToolStart(call.id, call.name, '');
        } else {
          events.onToolStart(call.id, call.name, safeLabel(() => tool.label(call.arguments)));
          try {
            output = await tool.run(call.arguments, {
              notes: this.deps.notes,
              indexer: this.deps.indexer,
              commands: this.deps.commands,
              signal,
              autoApproveEdits: opts.mode === 'auto',
              approve: (req) => events.approve(req),
              setTodos: (todos) => {
                session.todos = todos;
                events.onTodos(todos);
              },
            });
          } catch (err) {
            ok = false;
            output = `Error: ${(err as Error).message}`;
          }
        }
        if (output.length > MAX_TOOL_RESULT) output = output.slice(0, MAX_TOOL_RESULT) + '\n…(output truncated)';
        session.history.push({ role: 'tool', name: call.name, toolCallId: call.id, content: output });
        events.onToolEnd(call.id, ok, output);
      }
      if (signal.aborted) return;
    }
    events.onNotice(`Stopped after ${cfg.maxSteps} steps (mgbot.maxSteps). Say "continue" to let the agent keep going.`);
  }

  /** Replaces the history with a model-written summary to free up context. Returns the summary. */
  async compact(session: AgentSession, signal: AbortSignal, onToken: (t: string) => void): Promise<string> {
    if (!session.history.length) return '';
    const model = this.requireModel();
    const contextSize = await this.contextSize(model);
    const messages = toFallbackMessages(fitToBudget(session.history, contextSize - RESPONSE_RESERVE - 200));
    const result = await this.deps.providers.get().chat({
      model,
      contextSize,
      signal,
      messages: [...messages, { role: 'user', content: COMPACT_PROMPT }],
      onToken,
    });
    const summary = splitThinking(result.content).content;
    if (!summary) throw new Error('The model returned an empty summary; the conversation was left unchanged.');
    session.history = [
      { role: 'user', content: 'Summary of our conversation so far (earlier messages were compacted):' },
      { role: 'assistant', content: summary },
    ];
    return summary;
  }

  async contextSize(model: string): Promise<number> {
    if (!this.contextCache.has(model)) {
      this.contextCache.set(model, await this.deps.providers.get().contextLength(model).catch(() => undefined));
    }
    const max = this.contextCache.get(model);
    const configured = getConfig().contextSize;
    return max ? Math.min(configured, max) : configured;
  }

  private requireModel(): string {
    const model = getConfig().chatModel;
    if (!model) throw new Error('No chat model selected. Pick one in the MG Bot Models view (or download one first).');
    return model;
  }

  private async relevantCode(query: string): Promise<SearchHit[]> {
    if (!this.deps.indexer.ready || query.length < 8) return [];
    try {
      return await this.deps.indexer.search(query.slice(0, 2000), 4);
    } catch {
      return [];
    }
  }
}

export function editorContext(): PromptParts['editor'] {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') return undefined;
  const selection = editor.selection.isEmpty ? undefined : editor.document.getText(editor.selection);
  return {
    path: vscode.workspace.asRelativePath(editor.document.uri, true),
    language: editor.document.languageId,
    selection,
    cursorLine: editor.selection.active.line + 1,
  };
}

function safeLabel(fn: () => string): string {
  try {
    return String(fn()).slice(0, 120);
  } catch {
    return '';
  }
}
