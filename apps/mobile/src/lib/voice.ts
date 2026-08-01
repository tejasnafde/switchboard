/**
 * Thin wrapper over expo-speech-recognition. The native module only exists in
 * a dev build / APK: in Expo Go `requireNativeModule` throws at import time,
 * so the require sits behind a try/catch and every entry point degrades to
 * "unavailable" instead of crashing. Callers gate the mic UI on
 * isVoiceAvailable() and never touch the module directly.
 */
import { createLogger } from '@shared/logger'
import type {
  ExpoSpeechRecognitionErrorEvent,
  ExpoSpeechRecognitionResultEvent,
} from 'expo-speech-recognition'

const log = createLogger('mobile:voice')

/** How long the Android recognizer waits through silence before finalizing. */
const PAUSE_TOLERANCE_MS = 4000

type SpeechModule = (typeof import('expo-speech-recognition'))['ExpoSpeechRecognitionModule']

const speech: SpeechModule | null = (() => {
  try {
    const mod = require('expo-speech-recognition') as typeof import('expo-speech-recognition')
    return mod.ExpoSpeechRecognitionModule
  } catch (err) {
    log.info('native module unavailable (Expo Go) - voice input hidden', err)
    return null
  }
})()

/** True only in a dev build / APK with a working recognizer on the device. */
export function isVoiceAvailable(): boolean {
  if (!speech) return false
  try {
    return speech.isRecognitionAvailable()
  } catch (err) {
    log.warn('isRecognitionAvailable threw - treating voice as unavailable', err)
    return false
  }
}

/** Request mic + speech permission on first use. False means denied. */
export async function ensureVoicePermission(): Promise<boolean> {
  if (!speech) return false
  try {
    const current = await speech.getPermissionsAsync()
    if (current.granted) return true
    const asked = await speech.requestPermissionsAsync()
    if (!asked.granted) log.info('voice permission denied', { canAskAgain: asked.canAskAgain })
    return asked.granted
  } catch (err) {
    log.warn('voice permission check failed', err)
    return false
  }
}

export type VoiceHandlers = {
  /** Streaming partial transcript for the utterance in progress. */
  onPartial: (transcript: string) => void
  /** One finalized utterance. Fires repeatedly within a continuous session. */
  onFinal: (transcript: string) => void
  /** The session is over: stop(), or a fatal error. */
  onEnd: () => void
  onError: (message: string, code: string) => void
}

export type VoiceSession = { stop: () => void }

/**
 * Start one dictation session in the device locale.
 *
 * Continuous, so a thinking pause does not end the note: only a second tap or
 * a real error stops it. Some Android recognizers still finalize on silence
 * regardless of the flag, so the intent extras widen the silence windows too.
 * Continuous also means several final results per session, which is why
 * onFinal must accumulate rather than replace.
 */
export function startListening(handlers: VoiceHandlers): VoiceSession | null {
  if (!speech) return null
  const subs = [
    speech.addListener('result', (event: ExpoSpeechRecognitionResultEvent) => {
      const transcript = event.results[0]?.transcript ?? ''
      if (event.isFinal) handlers.onFinal(transcript)
      else handlers.onPartial(transcript)
    }),
    speech.addListener('error', (event: ExpoSpeechRecognitionErrorEvent) => {
      log.warn('recognition error', event.error, event.message)
      handlers.onError(event.message, event.error)
    }),
    speech.addListener('end', () => {
      for (const sub of subs) sub.remove()
      handlers.onEnd()
    }),
  ]
  try {
    speech.start({
      lang: deviceLocale(),
      interimResults: true,
      addsPunctuation: true,
      continuous: true,
      androidIntentOptions: {
        EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS: PAUSE_TOLERANCE_MS,
        EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS: PAUSE_TOLERANCE_MS,
      },
    })
  } catch (err) {
    log.error('speech.start failed', err)
    for (const sub of subs) sub.remove()
    return null
  }
  return {
    stop: () => {
      try {
        speech.stop()
      } catch (err) {
        log.warn('speech.stop failed', err)
      }
    },
  }
}

/** Append a transcript to the draft with a single joining space. */
export function joinDraft(base: string, transcript: string): string {
  if (!transcript) return base
  if (!base) return transcript
  return /\s$/.test(base) ? base + transcript : `${base} ${transcript}`
}

function deviceLocale(): string {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale
    if (locale && locale !== 'und') return locale
  } catch (err) {
    log.warn('device locale lookup failed - falling back to en-US', err)
  }
  return 'en-US'
}
