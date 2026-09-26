/**
 * The desktop's consumers of project-scopable settings, each resolved with
 * the chat's project (a worktree chat's `projectPath` is its parent project).
 * The global value comes from wherever the setting already lived. The
 * runtime mode resolves in agent-store (`defaultRuntimeModeFor`), where new
 * sessions are added.
 */
import { FOLLOW_UP_DEFAULT_KEY, parseFollowUpDefault, type TurnDelivery } from '@shared/turn-delivery'
import { SETTING_SESSION_ENV_MODE, SETTING_SHOW_FILE_DIFFS } from '@shared/project-settings'
import { useAgentStore } from '../stores/agent-store'
import { useLayoutStore } from '../stores/layout-store'
import { effectiveLocalSetting, useEffectiveSetting } from '../stores/project-settings-store'
import { getDefaultSessionEnvMode, type SessionEnvMode } from './session-env-mode'

function useSessionProjectPath(sessionId: string | null | undefined): string | undefined {
  return useAgentStore((s) => (sessionId ? s.sessions.find((x) => x.id === sessionId)?.projectPath : undefined))
}

export function useFollowUpDefault(sessionId: string | null | undefined): TurnDelivery {
  const projectPath = useSessionProjectPath(sessionId)
  const global = useLayoutStore((s) => s.followUpDefault)
  return parseFollowUpDefault(useEffectiveSetting(FOLLOW_UP_DEFAULT_KEY, projectPath, global).value)
}

export function useShowFileDiffCards(sessionId: string | null | undefined): boolean {
  const projectPath = useSessionProjectPath(sessionId)
  const global = useLayoutStore((s) => s.showFileDiffCards)
  return useEffectiveSetting(SETTING_SHOW_FILE_DIFFS, projectPath, String(global)).value === 'true'
}

/** Where a new chat in this project runs by default. */
export async function defaultSessionEnvModeFor(projectPath: string | null | undefined): Promise<SessionEnvMode> {
  const mode = effectiveLocalSetting(SETTING_SESSION_ENV_MODE, projectPath, await getDefaultSessionEnvMode())
  return mode === 'worktree' ? 'worktree' : 'local'
}
