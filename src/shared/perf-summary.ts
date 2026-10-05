export interface PerfEntry {
  name: string
  durationMs: number
  fields: Record<string, unknown>
}

export function parsePerfLogs(text: string, warn: (message: string) => void): PerfEntry[] {
  const entries: PerfEntry[] = []
  for (const line of text.split('\n')) {
    const match = /\[(?:SB:)?perf\] ([\w.-]+) (\d+(?:\.\d+)?)ms (\{.*\})$/.exec(line.trim())
    if (!match) continue
    let fields: unknown
    try {
      fields = JSON.parse(match[3])
    } catch {
      warn('Skipping malformed performance log JSON')
      continue
    }
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) continue
    entries.push({ name: match[1], durationMs: Number(match[2]), fields: fields as Record<string, unknown> })
  }
  return entries
}

export function summarizePerf(entries: PerfEntry[]) {
  const groups = new Map<string, PerfEntry[]>()
  for (const entry of entries) {
    const group = groups.get(entry.name) ?? []
    group.push(entry)
    groups.set(entry.name, group)
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([name, group]) => {
    const sorted = group.slice().sort((a, b) => a.durationMs - b.durationMs)
    const percentile = (p: number) => sorted[Math.ceil(sorted.length * p) - 1].durationMs
    return { name, count: sorted.length, p50: percentile(0.5), p90: percentile(0.9), max: sorted[sorted.length - 1].durationMs, worst: sorted.slice(-5).reverse() }
  })
}
