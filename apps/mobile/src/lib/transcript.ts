/**
 * Backend-corrected dictation: pure decision logic, vitest-tested at the root
 * suite (tests/unit/mobile-transcript-swap.test.ts). The hook does the I/O;
 * everything that decides stays here per the mobile testing rule.
 */
import { MAX_STT_AUDIO_BYTES, MAX_STT_AUDIO_DURATION_MS } from '@shared/stt'

/**
 * Whether the whisper text should replace the current draft, and with what.
 * Returns the replacement draft, or null to keep what is on screen.
 *
 * - `draftNow` is the composer content at the moment the correction arrives.
 * - `nativeFinal` is the draft snapshot taken when recording stopped.
 * - `whisperDraft` is the corrected draft ALREADY composed onto the
 *   pre-dictation base (the caller joins base + whisper transcript).
 *
 * The user keeps priority: any edit or send between stop and the correction
 * (draft no longer equals the snapshot) discards the correction silently.
 */
export function resolveTranscriptSwap(
  draftNow: string,
  nativeFinal: string,
  whisperDraft: string,
): string | null {
  if (whisperDraft.trim().length === 0) return null
  if (draftNow !== nativeFinal) return null
  if (whisperDraft === draftNow) return null
  return whisperDraft
}

/** Reason a recording is not worth refining, or null to proceed. */
export function refineSkipReason(input: {
  durationMs: number
  audioBytes: number
  hasBackend: boolean
}): 'no-backend' | 'too-long' | 'too-large' | 'empty' | null {
  if (!input.hasBackend) return 'no-backend'
  if (input.audioBytes <= 0) return 'empty'
  if (input.durationMs > MAX_STT_AUDIO_DURATION_MS) return 'too-long'
  if (input.audioBytes > MAX_STT_AUDIO_BYTES) return 'too-large'
  return null
}

/** Mime type for the persisted recording (Android writes wav, iOS wav/caf). */
export function audioMimeType(uri: string): string {
  return uri.toLowerCase().endsWith('.caf') ? 'audio/x-caf' : 'audio/wav'
}
