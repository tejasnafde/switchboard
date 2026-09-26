/**
 * The desktop's consumers of project-scopable settings, each resolved with
 * the chat's project (a worktree chat's `projectPath` is its parent project).
 * The global value comes from wherever the setting already lived.
 *
 * Values picked once when a chat is created await the project's overrides
 * first (`newChatDefaultsFor`). The two hooks re-render when a cold cache
 * fills, and the follow-up default only matters once a turn is running, by
 * which time it has.
 */
import { FOLLOW_UP_DEFAULT_KEY, parseFollowUpDefault, type TurnDelivery } from '@shared/turn-delivery'
import { SETTING_SESSION_ENV_MODE, SETTING_SHOW_FILE_DIFFS } from '@shared/project-settings'
import type { RuntimeMode } from '@shared/provider-events'
import { useAgentStore, defaultRuntimeModeFor, projectRuntimeModeOverride } from '../stores/agent-store'
import { useLayoutStore } from '../stores/layout-store'
import { effectiveLocalSetting, ensureProjectOverrides, useEffectiveSetting } from '../stores/project-settings-store'
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

/**
 * The mode and environment a new chat in this project starts with. A mode
 * carried over from the focused chat applies unless the project overrides it.
 */
export async function newChatDefaultsFor(
  projectPath: string,
  carriedMode?: RuntimeMode,
): Promise<{ runtimeMode: RuntimeMode; envMode: SessionEnvMode }> {
  const [globalEnvMode] = await Promise.all([getDefaultSessionEnvMode(), ensureProjectOverrides(projectPath)])
  const envMode = effectiveLocalSetting(SETTING_SESSION_ENV_MODE, projectPath, globalEnvMode) === 'worktree' ? 'worktree' : 'local'
  return {
    runtimeMode: projectRuntimeModeOverride(projectPath) ?? carriedMode ?? defaultRuntimeModeFor(projectPath),
    envMode,
  }
}
