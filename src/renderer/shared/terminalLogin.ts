/**
 * Maps the Terminal-tab "CLI Binary" selector value (UnifiedProviderPicker's
 * `termCommand`) to the provider identity main needs to resolve a login
 * terminal's real env. Returns null for anything that isn't a known
 * provider CLI (custom command) - there's no instance to resolve for those.
 */
export function terminalLoginAgentType(command: string): 'claude-code' | 'codex' | null {
  if (command === 'claude') return 'claude-code'
  if (command === 'codex') return 'codex'
  return null
}
