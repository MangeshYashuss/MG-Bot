/** An allow-listed prefix only auto-approves a single simple command (no chaining or redirection). */
export function isAllowListed(command: string, allowList: string[]): boolean {
  const cmd = command.trim();
  if (/[;&|><`]|\$\(/.test(cmd)) return false;
  return allowList.some((p) => p.trim() && (cmd === p.trim() || cmd.startsWith(p.trim() + ' ')));
}
