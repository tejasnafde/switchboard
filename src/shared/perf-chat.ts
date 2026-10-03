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
}
