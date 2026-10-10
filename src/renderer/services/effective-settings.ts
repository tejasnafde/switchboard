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
import { useAgentStore, projectRuntimeModeOverride } from '../stores/agent-store'
import { useLayoutStore } from '../stores/layout-store'
import { effectiveLocalSetting, ensureProjectOverrides, useEffectiveSetting } from '../stores/project-settings-store'
import { getDefaultSessionEnvMode, type SessionEnvMode } from './session-env-mode'
import { createRendererLogger } from '../logger'

const log = createRendererLogger('service:effective-settings')

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
 * The mode and environment a new chat in this project starts with.
 *
 * `runtimeMode` is only ever a mode carried over from the focused chat, and
 * not even that when the project overrides the mode. Otherwise it is
 * undefined and the session is unresolved (`initialRuntimeMode`): the chat
 * shows the project's default and the backend picks the mode. A carried mode
 * applies when the overrides cannot be read, since someone chose it.
 *
 * Where a chat runs is decided here and nowhere else, so on a failed read
 * it falls back to the global value.
 */
export async function newChatDefaultsFor(
  projectPath: string,
  carriedMode?: RuntimeMode,
): Promise<{ runtimeMode: RuntimeMode | undefined; envMode: SessionEnvMode }> {
  const [globalEnvMode, known] = await Promise.all([getDefaultSessionEnvMode(), ensureProjectOverrides(projectPath)])
  if (!known) {
    log.warn(
      `overrides for ${projectPath} are unknown: the new chat uses the global environment and lets the backend pick its mode`,
    )
    return { runtimeMode: carriedMode, envMode: globalEnvMode }
  }
  const envMode =
    effectiveLocalSetting(SETTING_SESSION_ENV_MODE, projectPath, globalEnvMode) === 'worktree' ? 'worktree' : 'local'
  return { runtimeMode: projectRuntimeModeOverride(projectPath) ? undefined : carriedMode, envMode }
}
