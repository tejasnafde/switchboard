export interface ChatLoadTiming {
  readMs: number
  parseMs: number
  diskMs: number
  dbMs: number
  mergeMs: number
  enrichMs: number
  diskBytes: number
  diskLines: number
  cacheHits: number
  /** Profile copies skipped because their bytes are a prefix of a larger copy. */
  prefixSkips: number
  /** Time spent proving profile copies are prefixes (sha256 of their bytes). */
  hashMs?: number
  /** Transcripts served from their byte-offset index instead of a parse. */
  indexHits?: number
  /** The merged history was reused: the transcripts and SQLite rows were unchanged. */
  mergeHit?: boolean
}

export interface ChatLoadDiagnostics {
  timing?: ChatLoadTiming
  loadStatus?: 'loaded' | 'missing' | 'error'
}
