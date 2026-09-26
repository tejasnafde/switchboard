/**
 * The per-project setting overrides this window knows, keyed by project path
 * as the project list spells it. The backend owns them and normalises paths;
 * this is a read cache that every write refreshes, so a consumer can resolve
 * a setting synchronously (a new chat, the composer's Enter).
 */
import { useEffect } from 'react'
import { create } from 'zustand'
import {
  effectiveSetting,
  resolveSetting,
  type ProjectOverrides,
  type ScopableSettingKey,
  type SettingSource,
} from '@shared/project-settings'
import { createRendererLogger } from '../logger'

const log = createRendererLogger('store:project-settings')

interface ProjectSettingsState {
  byProject: Readonly<Record<string, ProjectOverrides>>
  /** Replace the overrides of these projects with what the backend holds. */
  load: (projectPaths: readonly string[]) => Promise<void>
  setOverride: (projectPath: string, key: ScopableSettingKey, value: string) => Promise<void>
  removeOverride: (projectPath: string, key: ScopableSettingKey) => Promise<void>
}

export const useProjectSettingsStore = create<ProjectSettingsState>((set, get) => ({
  byProject: {},
  load: async (projectPaths) => {
    if (projectPaths.length === 0) return
    try {
      const loaded = await window.api.settings.projectOverrides([...projectPaths])
      set((state) => ({ byProject: { ...state.byProject, ...loaded } }))
    } catch (err) {
      log.warn('could not load project overrides', err)
    }
  },
  setOverride: async (projectPath, key, value) => {
    set((state) => ({ byProject: { ...state.byProject, [projectPath]: { ...state.byProject[projectPath], [key]: value } } }))
    try {
      await window.api.settings.setProjectOverride(projectPath, key, value)
    } catch (err) {
      log.warn(`could not save the ${key} override for ${projectPath}`, err)
    }
    await get().load([projectPath])
  },
  removeOverride: async (projectPath, key) => {
    set((state) => {
      const { [key]: _removed, ...rest } = state.byProject[projectPath] ?? {}
      return { byProject: { ...state.byProject, [projectPath]: rest } }
    })
    try {
      await window.api.settings.removeProjectOverride(projectPath, key)
    } catch (err) {
      log.warn(`could not remove the ${key} override for ${projectPath}`, err)
    }
    await get().load([projectPath])
  },
}))

export function projectOverride(projectPath: string | null | undefined, key: ScopableSettingKey): string | undefined {
  if (!projectPath) return undefined
  return useProjectSettingsStore.getState().byProject[projectPath]?.[key]
}

/** Resolve against this window's cache, given the global value the caller already holds. */
export function effectiveLocalSetting(key: ScopableSettingKey, projectPath: string | null | undefined, global: string | null | undefined): string {
  return effectiveSetting(key, projectPath, { override: (path) => projectOverride(path, key), global: () => global })
}

/** The same, as a hook that follows override changes. */
export function useEffectiveSetting(
  key: ScopableSettingKey,
  projectPath: string | null | undefined,
  global: string | null | undefined,
): { value: string; source: SettingSource } {
  const override = useProjectSettingsStore((state) => (projectPath ? state.byProject[projectPath]?.[key] : undefined))
  const known = useProjectSettingsStore((state) => !projectPath || projectPath in state.byProject)
  // A chat whose path is spelled differently from the project list's is
  // looked up on its own; the backend matches the spellings.
  useEffect(() => {
    if (!known && projectPath) void useProjectSettingsStore.getState().load([projectPath])
  }, [known, projectPath])
  return resolveSetting(key, projectPath, { override: () => override, global: () => global })
}
