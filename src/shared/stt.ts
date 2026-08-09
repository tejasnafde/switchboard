/**
 * Backend speech-to-text contract: request/response shapes for
 * SttChannels.TRANSCRIBE, status pushes for SttChannels.STATUS, and the pure
 * prompt builder that seeds whisper.cpp with project vocabulary. Shared so the
 * mobile client and both backend hosts agree on the wire types.
 */

/** Ggml model file served from huggingface.co/ggerganov/whisper.cpp. */
export const WHISPER_MODEL_NAME = 'ggml-large-v3-turbo-q5_0.bin'

/** Hard cap on decoded audio accepted by the TRANSCRIBE handler. */
export const MAX_STT_AUDIO_BYTES = 25 * 1024 * 1024

/** Client-side policy: recordings longer than this skip refinement. */
export const MAX_STT_AUDIO_DURATION_MS = 2 * 60 * 1000

/** Prompt budget: ~200 tokens of vocabulary at ~4 chars per token. */
export const STT_PROMPT_CAP_CHARS = 800

export type SttServerStatus = 'stopped' | 'downloading' | 'starting' | 'ready' | 'error'

/** Pushed on SttChannels.STATUS whenever the whisper server changes state. */
export interface SttStatusEvent {
  status: SttServerStatus
  /** Download progress 0-100, only while `status` is 'downloading'. */
  pct?: number
  /** Human-readable cause, only while `status` is 'error'. */
  detail?: string
}

export interface SttTranscribeRequest {
  /** Base64 of the raw audio file, without a data-URL prefix. */
  audioBase64: string
  /** e.g. 'audio/wav'. Informational: whisper-server sniffs the content. */
  mimeType: string
  /** Project the dictation belongs to - seeds the vocabulary prompt. */
  projectPath: string
  durationMs: number
}

export type SttTranscribeResult =
  | { ok: true; text: string; provider: 'whisper'; modelId: string }
  | { ok: false; error: string }

/** Decoded byte count of a base64 payload without materialising the buffer. */
export function base64DecodedBytes(base64: string): number {
  let padding = 0
  if (base64.endsWith('==')) padding = 2
  else if (base64.endsWith('=')) padding = 1
  return Math.floor((base64.length * 3) / 4) - padding
}

/**
 * Seed whisper's initial prompt with hot project identifiers so it prefers
 * `useDictation.ts` over "use dictation dot yes". Inputs are repo-relative
 * paths (basenames and path segments both bias decoding) plus any recent
 * identifiers the caller wants weighted. Deduped, order-preserving, capped.
 */
export function buildSttPrompt(
  fileNames: readonly string[],
  recentIdentifiers: readonly string[] = [],
  capChars: number = STT_PROMPT_CAP_CHARS,
): string {
  const seen = new Set<string>()
  const terms: string[] = []
  const push = (raw: string): void => {
    const term = raw.trim()
    if (term.length < 3) return
    const key = term.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    terms.push(term)
  }
  for (const ident of recentIdentifiers) push(ident)
  for (const path of fileNames) {
    for (const segment of path.split('/')) push(segment)
  }
  if (terms.length === 0) return ''
  const prefix = 'Software project dictation. Vocabulary: '
  let out = prefix
  for (const term of terms) {
    const next = out === prefix ? out + term : `${out}, ${term}`
    if (next.length > capChars) break
    out = next
  }
  return out === prefix ? '' : out
}
