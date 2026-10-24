/**
 * The last project list each machine answered, so the Projects screen has
 * something to show while the machine is offline.
 */
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { Project, Workspace } from '@shared/types'
import { withoutDemo } from '@shared/phone-demo/phone-demo'

export interface SavedProjects {
  projects: Project[]
  workspaces: Workspace[]
}

interface SavedProjectsState {
  byConnection: Record<string, SavedProjects>
  save: (connectionId: string, saved: SavedProjects) => void
  forget: (connectionId: string) => void
}

export const useSavedProjectsStore = create<SavedProjectsState>()(
  persist(
    (set) => ({
      byConnection: {},
      save: (connectionId, saved) => set((s) => ({ byConnection: { ...s.byConnection, [connectionId]: saved } })),
      forget: (connectionId) =>
        set((s) => {
          if (!(connectionId in s.byConnection)) return {}
          const byConnection = { ...s.byConnection }
          delete byConnection[connectionId]
          return { byConnection }
        }),
    }),
    {
      name: 'sb-saved-projects',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({ byConnection: withoutDemo(s.byConnection) }),
    },
  ),
)
