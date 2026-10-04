import { create } from 'zustand'
import type { ChatSlot } from '../services/chat-workspace'

interface OpeningChat { id: string; title: string; projectPath: string; ticket: number }
export interface ChatWait { label: string; pending: boolean; error?: boolean }
interface ChatWaitStore {
  opening: Partial<Record<ChatSlot, OpeningChat>>
  waits: Record<string, ChatWait | undefined>
  open: (slot: ChatSlot, chat: Omit<OpeningChat, 'ticket'>) => number
  finishOpen: (slot: ChatSlot, ticket: number) => void
  begin: (id: string, label: string) => void
  fail: (id: string, label: string) => void
  finish: (id: string) => void
}
let ticket = 0
export const useChatWaitStore = create<ChatWaitStore>((set) => ({
  opening: {},
  waits: {},
  open: (slot, chat) => {
    const next = ++ticket
    set((state) => {
      const waits = { ...state.waits }
      if (!waits[chat.id]?.pending) delete waits[chat.id]
      return { opening: { ...state.opening, [slot]: { ...chat, ticket: next } }, waits }
    })
    return next
  },
  finishOpen: (slot, completed) => set((state) => {
    if (state.opening[slot]?.ticket !== completed) return state
    const opening = { ...state.opening }
    delete opening[slot]
    return { opening }
  }),
  begin: (id, label) => set((state) => ({ waits: { ...state.waits, [id]: { label, pending: true } } })),
  fail: (id, label) => set((state) => ({ waits: { ...state.waits, [id]: { label, pending: false, error: true } } })),
  finish: (id) => set((state) => {
    if (!state.waits[id]?.pending) return state
    const waits = { ...state.waits }
    delete waits[id]
    return { waits }
  }),
}))
