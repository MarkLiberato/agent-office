/** Codex resume uses a subcommand and session id before any positional prompt. */
export function codexResumeArgs(args: string[], sessionId: string): string[] {
  return args[0] === 'resume' ? [...args] : ['resume', sessionId, ...args];
}

/** Manual Office Agent mode overrides inherited Codex permission configuration. */
export function codexPermissionArgs(args: string[], autoMode: boolean): string[] {
  if (autoMode) return [...args];
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // An explicit argument terminator starts prompt content, not more CLI options.
    if (arg === '--') { kept.push(...args.slice(i)); break; }
    if (['--dangerously-bypass-approvals-and-sandbox', '--full-auto', '--yolo'].includes(arg)) continue;
    if (['-a', '--ask-for-approval', '-s', '--sandbox'].includes(arg)) { i++; continue; }
    if (/^(--ask-for-approval|--sandbox)=/.test(arg) || /^-[as].+/.test(arg)) continue;
    if (arg === '-c' || arg === '--config') {
      if (/^(approval_policy|sandbox_mode)\s*=/.test(args[i + 1] ?? '')) { i++; continue; }
    }
    if (/^(?:--config=|-c)(approval_policy|sandbox_mode)\s*=/.test(arg)) continue;
    kept.push(arg);
  }
  return ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request', ...kept];
}
