import { ChildProcess, spawn } from 'child_process';
import * as vscode from 'vscode';
import { getConfig, workspaceRoots } from '../../config';
import { isAllowListed } from '../../util/commandPolicy';
import { resolveInWorkspace } from '../../util/paths';
import { Tool, str } from './types';

const MAX_OUTPUT = 20_000;

/** Runs agent commands as child processes and mirrors their output into an "MG Bot" terminal. */
export class CommandRunner implements vscode.Disposable {
  private terminal?: vscode.Terminal;
  private readonly writer = new vscode.EventEmitter<string>();
  private child?: ChildProcess;

  private show(): void {
    if (!this.terminal || this.terminal.exitStatus) {
      const pty: vscode.Pseudoterminal = {
        onDidWrite: this.writer.event,
        open: () => this.writer.fire('MG Bot command output\r\n'),
        close: () => {
          this.terminal = undefined;
        },
        handleInput: (data) => {
          if (data === '\x03') this.kill(); // Ctrl+C
        },
      };
      this.terminal = vscode.window.createTerminal({ name: 'MG Bot', pty });
    }
    this.terminal.show(true);
  }

  run(command: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<{ code: number | null; output: string; timedOut: boolean }> {
    this.show();
    this.writer.fire(`\r\n\x1b[36m${cwd}> ${command}\x1b[0m\r\n`);
    const [shell, shellArgs] =
      process.platform === 'win32'
        ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]]
        : [process.env.SHELL || '/bin/sh', ['-c', command]];

    return new Promise((resolve) => {
      let output = '';
      let timedOut = false;
      const child = spawn(shell, shellArgs, { cwd, env: process.env, detached: process.platform !== 'win32' });
      this.child = child;
      const onData = (buf: Buffer) => {
        const text = buf.toString('utf8');
        output += text;
        if (output.length > MAX_OUTPUT * 2) output = output.slice(-MAX_OUTPUT);
        this.writer.fire(text.replace(/\r?\n/g, '\r\n'));
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      const timer = setTimeout(() => {
        timedOut = true;
        this.kill();
      }, timeoutMs);
      const onAbort = () => this.kill();
      signal.addEventListener('abort', onAbort);
      const finish = (code: number | null) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.child = undefined;
        this.writer.fire(`\x1b[90m[exit ${code ?? 'killed'}]\x1b[0m\r\n`);
        resolve({ code, output: output.length > MAX_OUTPUT ? '…(earlier output trimmed)\n' + output.slice(-MAX_OUTPUT) : output, timedOut });
      };
      child.on('error', (err) => {
        output += `\n${err.message}`;
        finish(null);
      });
      child.on('close', (code) => finish(code));
    });
  }

  kill(): void {
    const child = this.child;
    if (!child?.pid) return;
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }
  }

  dispose(): void {
    this.kill();
    this.terminal?.dispose();
    this.writer.dispose();
  }
}

export const runCommandTool: Tool = {
  spec: {
    name: 'run_command',
    description:
      'Run a shell command in the workspace (PowerShell on Windows, the user\'s shell elsewhere), e.g. to run tests, builds, linters or git. The user approves each command. Returns exit code and output. Do not start long-running servers or watchers.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line to run.' },
        cwd: { type: 'string', description: 'Working folder relative to the workspace root (optional).' },
      },
      required: ['command'],
    },
  },
  label: (a) => a.command ?? '',
  async run(args, ctx) {
    const command = str(args.command, 'command');
    const { abs: cwd, rel } = resolveInWorkspace(workspaceRoots(), args.cwd || '.');
    const cfg = getConfig();
    if (!isAllowListed(command, cfg.commandAllowList)) {
      const ok = await ctx.approve({ kind: 'command', title: 'Run command', detail: `${rel === '.' ? '' : rel + '> '}${command}` });
      if (!ok) return 'The user declined to run this command. Do not retry it; ask the user or continue without it.';
    }
    const { code, output, timedOut } = await ctx.commands.run(command, cwd, cfg.commandTimeoutSeconds * 1000, ctx.signal);
    const head = timedOut ? `Command timed out after ${cfg.commandTimeoutSeconds}s and was stopped.` : `Exit code: ${code ?? 'killed'}`;
    return `${head}\n${output.trim() || '(no output)'}`;
  },
};
