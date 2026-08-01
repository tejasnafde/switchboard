/**
 * Dictation session management, lifted out of the old MicButton so the new
 * gesture button can drive it. Partial transcripts stream into the draft by
 * composing onto a base snapshot, which each finalized utterance extends, so a
 * long continuous dictation keeps its earlier sentences.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createLogger } from '@shared/logger'
import {
  ensureVoicePermission,
  isVoiceAvailable,
  joinDraft,
  startListening,
  type VoiceSession,
} from '../lib/voice'

const log = createLogger('mobile:dictation')

export type VoiceNote = { message: string; showSettingsLink?: boolean }

const NOTE_TTL_MS = 6000

/** Error codes that end a session without anything worth telling the user. */
const QUIET_ERROR_CODES = new Set(['aborted', 'no-speech', 'speech-timeout'])

export interface Dictation {
  available: boolean
  listening: boolean
  start: () => Promise<boolean>
  stop: () => void
}

export function useDictation({
  draft,
  onDraft,
  onNote,
}: {
  draft: string
  onDraft: (text: string) => void
  onNote: (note: VoiceNote | null) => void
}): Dictation {
  const available = useMemo(() => isVoiceAvailable(), [])
  const [listening, setListening] = useState(false)
  const sessionRef = useRef<VoiceSession | null>(null)
  const baseRef = useRef('')
  const noteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // The draft is only read when a session starts; a ref keeps the handlers
  // stable instead of rebuilding them on every keystroke.
  const draftRef = useRef(draft)
  draftRef.current = draft

  const postNote = useCallback(
    (note: VoiceNote) => {
      if (noteTimerRef.current) clearTimeout(noteTimerRef.current)
      onNote(note)
      // Permission notes carry the Settings action, so they stay until the next
      // interaction instead of vanishing mid-tap.
      if (!note.showSettingsLink) {
        noteTimerRef.current = setTimeout(() => onNote(null), NOTE_TTL_MS)
      }
    },
    [onNote],
  )

  useEffect(
    () => () => {
      if (noteTimerRef.current) clearTimeout(noteTimerRef.current)
      sessionRef.current?.stop()
    },
    [],
  )

  const stop = useCallback(() => {
    sessionRef.current?.stop()
  }, [])

  const start = useCallback(async () => {
    if (sessionRef.current) return true
    onNote(null)
    const granted = await ensureVoicePermission()
    if (!granted) {
      postNote({ message: 'Microphone permission needed.', showSettingsLink: true })
      return false
    }
    baseRef.current = draftRef.current
    const session = startListening({
      onPartial: (text) => onDraft(joinDraft(baseRef.current, text)),
      // A continuous session finalizes each utterance separately, so the base
      // absorbs it: without this the next sentence overwrites the last one.
      onFinal: (text) => {
        baseRef.current = joinDraft(baseRef.current, text)
        onDraft(baseRef.current)
      },
      onEnd: () => {
        sessionRef.current = null
        setListening(false)
      },
      onError: (message, code) => {
        if (QUIET_ERROR_CODES.has(code)) return
        if (code === 'not-allowed') {
          postNote({ message: 'Microphone permission needed.', showSettingsLink: true })
          return
        }
        log.warn('dictation failed', message)
        postNote({ message: `Voice input failed: ${message}` })
      },
    })
    if (!session) {
      postNote({ message: 'Voice input failed to start.' })
      return false
    }
    sessionRef.current = session
    setListening(true)
    return true
  }, [onDraft, onNote, postNote])

  return { available, listening, start, stop }
}
