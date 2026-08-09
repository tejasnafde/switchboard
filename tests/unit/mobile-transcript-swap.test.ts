/**
 * Backend-corrected dictation decisions (apps/mobile/src/lib/transcript.ts):
 * when the whisper text may replace the draft, and when a recording is not
 * worth shipping at all. Pure, so the I/O-heavy hook stays thin.
 */
import { describe, it, expect } from 'vitest'
import {
  audioMimeType,
  refineSkipReason,
  resolveTranscriptSwap,
} from '../../apps/mobile/src/lib/transcript'
import { MAX_STT_AUDIO_BYTES, MAX_STT_AUDIO_DURATION_MS } from '../../src/shared/stt'

describe('resolveTranscriptSwap', () => {
  const nativeFinal = 'use dictation dot yes please'
  const whisper = 'useDictation.ts please'

  it('replaces an untouched draft with the corrected text', () => {
    expect(resolveTranscriptSwap(nativeFinal, nativeFinal, whisper)).toBe(whisper)
  })

  it('keeps the draft once the user edited it after recording stopped', () => {
    expect(resolveTranscriptSwap(nativeFinal + ' and more', nativeFinal, whisper)).toBeNull()
  })

  it('keeps the draft after the user sent it (composer now empty)', () => {
    expect(resolveTranscriptSwap('', nativeFinal, whisper)).toBeNull()
  })

  it('ignores an empty or whitespace correction', () => {
    expect(resolveTranscriptSwap(nativeFinal, nativeFinal, '')).toBeNull()
    expect(resolveTranscriptSwap(nativeFinal, nativeFinal, '   ')).toBeNull()
  })

  it('reports no-op when whisper agrees with the native recognizer', () => {
    expect(resolveTranscriptSwap(nativeFinal, nativeFinal, nativeFinal)).toBeNull()
  })
})

describe('refineSkipReason', () => {
  const base = { durationMs: 5000, audioBytes: 160_000, hasBackend: true }

  it('proceeds for a normal recording with a backend', () => {
    expect(refineSkipReason(base)).toBeNull()
  })

  it('skips without a connected backend', () => {
    expect(refineSkipReason({ ...base, hasBackend: false })).toBe('no-backend')
  })

  it('skips an empty recording', () => {
    expect(refineSkipReason({ ...base, audioBytes: 0 })).toBe('empty')
  })

  it('skips recordings past the duration policy', () => {
    expect(refineSkipReason({ ...base, durationMs: MAX_STT_AUDIO_DURATION_MS + 1 })).toBe('too-long')
    expect(refineSkipReason({ ...base, durationMs: MAX_STT_AUDIO_DURATION_MS })).toBeNull()
  })

  it('skips audio past the byte cap', () => {
    expect(refineSkipReason({ ...base, audioBytes: MAX_STT_AUDIO_BYTES + 1 })).toBe('too-large')
  })
})

describe('audioMimeType', () => {
  it('labels wav and caf recordings from the file extension', () => {
    expect(audioMimeType('file:///cache/recording_123.wav')).toBe('audio/wav')
    expect(audioMimeType('file:///cache/audio_ABC.CAF')).toBe('audio/x-caf')
    expect(audioMimeType('file:///cache/unknown')).toBe('audio/wav')
  })
})
