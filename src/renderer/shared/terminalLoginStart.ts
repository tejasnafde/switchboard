/**
 * Orchestrates the Terminal-tab "Start Terminal Session" button
 * (UnifiedProviderPicker.tsx). Awaits the underlying `terminal:create` IPC
 * call BEFORE creating any agent-store session, activating it, or
 * persisting a conversation row - a rejected create (missing/disabled/
 * wrong-kind login instance, see terminal-login-env.ts) must never leave a
 * dead session/conversation behind with no working PTY, and must never
 * surface as an unhandled promise rejection.
 *
 * Dependencies are injected so the ordering guarantee is testable without
 * React, xterm, or Electron IPC.
 */

export interface StartTerminalSessionDeps {
  createTerminal: (
    paneId: string,
    cwd: string | undefined,
    command: string,
    machineId: string | undefined,
    loginInstance: { agentType: 'claude-code' | 'codex'; instanceId?: string } | undefined,
  ) => Promise<unknown>
  addSession: (session: {
    id: string
    type: 'terminal'
    status: 'idle'
    projectPath: string
    terminalPaneId: string
    machineId: string | undefined
    title: string
    instanceId: string | undefined
  }) => void
  setActiveSession: (id: string) => void
  createConversation: (params: {
    id: string
    projectPath: string
    agentType: 'terminal'
    title: string
  }) => Promise<unknown>
  emitSessionCreated: (payload: {
    id: string
    projectPath: string
    title: string
    startedAt: number
    source: 'switchboard'
    agentType: 'terminal'
  }) => void
  /** Injectable clock so pane/session ids are deterministic in tests. */
  now?: () => number
}

export interface StartTerminalSessionParams {
  projectPath: string
  machineId: string | undefined
  command: string
  loginInstance: { agentType: 'claude-code' | 'codex'; instanceId?: string } | undefined
  instanceId: string | undefined
}

export interface StartTerminalSessionResult {
  ok: boolean
  error?: string
}

export async function startTerminalSession(
  deps: StartTerminalSessionDeps,
  params: StartTerminalSessionParams,
): Promise<StartTerminalSessionResult> {
  const now = deps.now ?? Date.now
  const paneId = `term_${now()}`
  const sessionId = `agent_${now()}`

  try {
    await deps.createTerminal(paneId, params.projectPath, params.command, params.machineId, params.loginInstance)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  deps.addSession({
    id: sessionId,
    type: 'terminal',
    status: 'idle',
    projectPath: params.projectPath,
    terminalPaneId: paneId,
    machineId: params.machineId,
    title: params.command,
    instanceId: params.instanceId,
  })
  deps.setActiveSession(sessionId)
  deps.createConversation({
    id: sessionId,
    projectPath: params.projectPath,
    agentType: 'terminal',
    title: params.command,
  }).catch(() => {})
  deps.emitSessionCreated({
    id: sessionId,
    projectPath: params.projectPath,
    title: params.command,
    startedAt: now(),
    source: 'switchboard',
    agentType: 'terminal',
  })

  return { ok: true }
}
