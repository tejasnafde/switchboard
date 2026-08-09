/**
 * Dictation session management, lifted out of the old MicButton so the new
 * gesture button can drive it. Partial transcripts stream into the draft by
 * composing onto a base snapshot, which each finalized utterance extends, so a
 * long continuous dictation keeps its earlier sentences.
 *
 * With a `refine` config, the raw audio of the session is also persisted and
 * shipped to the paired backend, whose whisper.cpp server is far better at
 * technical vocabulary than the on-device recognizer. The corrected text
 * replaces the draft only when the user has not touched it since recording
 * stopped - the decision itself lives in lib/transcript.ts, pure and tested.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as FileSystem from 'expo-file-system/legacy'
import { createLogger } from '@shared/logger'
import { base64DecodedBytes } from '@shared/stt'
import {
  ensureVoicePermission,
  isVoiceAvailable,
  joinDraft,
  startListening,
  type VoiceSession,
} from '../lib/voice'
import { audioMimeType, refineSkipReason, resolveTranscriptSwap } from '../lib/transcript'
import { getClient } from '../stores/connections'

const log = createLogger('mobile:dictation')

export type VoiceNote = { message: string; showSettingsLink?: boolean }

const NOTE_TTL_MS = 6000

/**
 * How long the phone waits for the backend correction. A warm whisper answers
 * in a few seconds; a cold backend may be downloading a ~574 MB model, which
 * keeps warming after we give up, so the NEXT dictation gets the benefit.
 */
const REFINE_TIMEOUT_MS = 30_000

/** Error codes that end a session without anything worth telling the user. */
const QUIET_ERROR_CODES = new Set(['aborted', 'no-speech', 'speech-timeout'])

/** One notice per app run: refinement failures degrade silently after that. */
let refineNoticeShown = false

export interface Dictation {
  available: boolean
  listening: boolean
  /** A backend correction of the last recording is in flight. */
  refining: boolean
  start: () => Promise<boolean>
  stop: () => void
}

/** Where to send the recording for correction, and which repo biases it. */
export interface RefineConfig {
  connectionId: string
  projectPath: string
}

/** Per-session refinement bookkeeping; audioend/end order is not guaranteed. */
interface RefineSession {
  /** undefined until audioend fires; null when persistence failed. */
  uri: string | null | undefined
  ended: boolean
  launched: boolean
  startedAt: number
  /** Draft before any dictation, the base the whisper text composes onto. */
  base: string
  /** Draft at the moment recording stopped - the user-priority reference. */
  nativeFinal: string
}

export function useDictation({
  draft,
  onDraft,
  onNote,
  refine,
}: {
  draft: string
  onDraft: (text: string) => void
  onNote: (note: VoiceNote | null) => void
  refine?: RefineConfig
}): Dictation {
  const available = useMemo(() => isVoiceAvailable(), [])
  const [listening, setListening] = useState(false)
  const [refining, setRefining] = useState(false)
  const sessionRef = useRef<VoiceSession | null>(null)
  const baseRef = useRef('')
  const noteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  // The draft is only read when a session starts; a ref keeps the handlers
  // stable instead of rebuilding them on every keystroke.
  const draftRef = useRef(draft)
  draftRef.current = draft
  const refineRef = useRef(refine)
  refineRef.current = refine

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
      mountedRef.current = false
      if (noteTimerRef.current) clearTimeout(noteTimerRef.current)
      sessionRef.current?.stop()
    },
    [],
  )

  const stop = useCallback(() => {
    sessionRef.current?.stop()
  }, [])

  const refineOnce = useCallback(
    (message: string) => {
      log.warn('refinement unavailable', message)
      if (refineNoticeShown || !mountedRef.current) return
      refineNoticeShown = true
      postNote({ message: 'Transcript correction unavailable. Kept the on-device text.' })
    },
    [postNote],
  )

  const runRefinement = useCallback(
    async (session: RefineSession, config: RefineConfig): Promise<void> => {
      const uri = session.uri
      if (!uri) return // Recognizer could not persist; nothing to refine.
      const client = getClient(config.connectionId)
      let audioBase64: string
      try {
        audioBase64 = await FileSystem.readAsStringAsync(uri, { encoding: 'base64' })
      } catch (err) {
        log.warn('persisted dictation audio unreadable - skipping refinement', err)
        return
      }
      const cleanup = (): void => {
        // The recording sits in the app cache; one dictation, one file, gone.
        FileSystem.deleteAsync(uri, { idempotent: true }).catch((err) =>
          log.warn('dictation audio cleanup failed', err),
        )
      }
      const skip = refineSkipReason({
        durationMs: Date.now() - session.startedAt,
        audioBytes: base64DecodedBytes(audioBase64),
        hasBackend: client != null,
      })
      if (skip) {
        log.info('refinement skipped', { reason: skip })
        cleanup()
        return
      }
      if (mountedRef.current) setRefining(true)
      let timer: ReturnType<typeof setTimeout> | null = null
      try {
        const call = client!.transcribe({
          audioBase64,
          mimeType: audioMimeType(uri),
          projectPath: config.projectPath,
          durationMs: Date.now() - session.startedAt,
        })
        // A rejection landing AFTER the timeout won the race would otherwise
        // surface as an unhandled rejection; the race path reports the live one.
        call.catch((err) => log.debug('transcribe settled late', err))
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('backend did not answer in time')),
            REFINE_TIMEOUT_MS,
          )
        })
        const result = await Promise.race([call, timeout])
        if (!result.ok) {
          refineOnce(result.error)
          return
        }
        const swapped = resolveTranscriptSwap(
          draftRef.current,
          session.nativeFinal,
          joinDraft(session.base, result.text),
        )
        if (swapped !== null && mountedRef.current) onDraft(swapped)
      } catch (err) {
        refineOnce(err instanceof Error ? err.message : String(err))
      } finally {
        if (timer) clearTimeout(timer)
        if (mountedRef.current) setRefining(false)
        cleanup()
      }
    },
    [onDraft, refineOnce],
  )

  const start = useCallback(async () => {
    if (sessionRef.current) return true
    onNote(null)
    const granted = await ensureVoicePermission()
    if (!granted) {
      postNote({ message: 'Microphone permission needed.', showSettingsLink: true })
      return false
    }
    baseRef.current = draftRef.current
    const refineConfig = refineRef.current
    const refineSession: RefineSession | null = refineConfig
      ? {
          uri: undefined,
          ended: false,
          launched: false,
          startedAt: Date.now(),
          base: draftRef.current,
          nativeFinal: '',
        }
      : null
    // audioend and end race across platforms: whichever lands second launches.
    const maybeRefine = (): void => {
      if (!refineSession || !refineConfig) return
      if (!refineSession.ended || refineSession.uri === undefined || refineSession.launched) return
      refineSession.launched = true
      void runRefinement(refineSession, refineConfig)
    }
    const session = startListening(
      {
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
          if (refineSession) {
            refineSession.ended = true
            refineSession.nativeFinal = draftRef.current
            maybeRefine()
          }
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
        onAudioFile: (uri) => {
          if (!refineSession) return
          refineSession.uri = uri
          maybeRefine()
        },
      },
      refineSession ? { persistAudio: true } : undefined,
    )
    if (!session) {
      postNote({ message: 'Voice input failed to start.' })
      return false
    }
    sessionRef.current = session
    setListening(true)
    return true
  }, [onDraft, onNote, postNote, runRefinement])

  return { available, listening, refining, start, stop }
}
