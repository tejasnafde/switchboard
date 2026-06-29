/**
 * Minimal ~/.ssh/config parser for the "Add machine" picker. Surfaces real host
 * aliases (no wildcards) that have a HostName, with their User and Port.
 * Not a full ssh_config implementation - no Match, Include, or token expansion.
 */
import type { SshHost } from '@shared/machines'

interface Block {
  aliases: string[]
  hostName?: string
  user?: string
  port?: number
}

function isPattern(alias: string): boolean {
  return alias.includes('*') || alias.includes('?')
}

export function parseSshConfig(text: string): SshHost[] {
  const blocks: Block[] = []
  let current: Block | null = null

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue

    const sep = line.search(/[\s=]/)
    if (sep === -1) continue
    const keyword = line.slice(0, sep).toLowerCase()
    const value = line.slice(sep + 1).trim().replace(/^=\s*/, '')

    if (keyword === 'host') {
      current = { aliases: value.split(/\s+/).filter((a) => a && !isPattern(a)) }
      blocks.push(current)
    } else if (!current) {
      continue
    } else if (keyword === 'hostname') {
      current.hostName = value
    } else if (keyword === 'user') {
      current.user = value
    } else if (keyword === 'port') {
      const n = Number(value)
      if (Number.isFinite(n)) current.port = n
    }
  }

  return blocks
    .filter((b) => b.hostName && b.aliases.length > 0)
    .flatMap((b) =>
      b.aliases.map((alias) => ({ alias, hostName: b.hostName, user: b.user, port: b.port ?? 22 })),
    )
}
