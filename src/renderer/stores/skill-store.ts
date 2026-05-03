import { create } from 'zustand'

/**
 * Per-session cache of agent-advertised slash-command names.
 *
 * Populated by `ChatInput` when it fetches skills from the provider, read
 * by `MessageBubble` so it can validate a leading `/<cmd>` against the
 * registry before rendering it as a `SkillChip`. Without this validation,
 * a typo like `/halp` would visually masquerade as a recognized skill in
 * the sent bubble.
 *
 * Names are stored lowercase to keep the membership check case-insensitive
 * without forcing every caller to normalize.
 */
interface SkillStore {
  /** sessionId → lowercased skill name set. */
  namesBySession: Record<string, Set<string>>
  setSkillNames: (sessionId: string, names: string[]) => void
}

export const useSkillStore = create<SkillStore>((set) => ({
  namesBySession: {},
  setSkillNames: (sessionId, names) =>
    set((state) => ({
      namesBySession: {
        ...state.namesBySession,
        [sessionId]: new Set(names.map((n) => n.toLowerCase())),
      },
    })),
}))
