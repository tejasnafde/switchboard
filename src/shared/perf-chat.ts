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
}

export interface ChatLoadDiagnostics {
  timing?: ChatLoadTiming
  loadStatus?: 'loaded' | 'missing' | 'error'
}
