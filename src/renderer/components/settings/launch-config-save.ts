import { serializeLaunchConfigFile, type LaunchConfigFile } from '@shared/launch-config'

export type LaunchConfigSaveOutcome =
  | { kind: 'saved' }
  | { kind: 'failed'; error: string }
  /** The user picked another project while the write was in flight. */
  | { kind: 'stale' }

/**
 * Write `config` to `project`, then say whether the caller may apply it.
 * Only `saved` may touch the editor: after a failure the edit is still
 * unsaved, and after a project switch the editor holds the other project,
 * so applying either would show one state and later save another.
 */
export async function saveLaunchConfigFor(
  project: string,
  config: LaunchConfigFile,
  save: (project: string, text: string) => Promise<unknown>,
  isCurrent: (project: string) => boolean,
): Promise<LaunchConfigSaveOutcome> {
  try {
    await save(project, serializeLaunchConfigFile(config))
  } catch (e) {
    if (!isCurrent(project)) return { kind: 'stale' }
    return { kind: 'failed', error: e instanceof Error ? e.message : String(e) }
  }
  return isCurrent(project) ? { kind: 'saved' } : { kind: 'stale' }
}
