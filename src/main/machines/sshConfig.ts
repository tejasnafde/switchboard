/**
 * Minimal ~/.ssh/config parser for the "Add machine" picker. Surfaces real host
 * aliases (no wildcards) that have a HostName, with their User and Port.
 * Not a full ssh_config implementation - no Match, Include, or token expansion.
 */
import type { SshHost, SshIapTarget } from '@shared/machines'

interface Block {
  aliases: string[]
  hostName?: string
  user?: string
  port?: number
  proxyCommand?: string
}

function isPattern(alias: string): boolean {
  return alias.includes('*') || alias.includes('?')
}

/**
 * Real ssh config files pick up odd blocks - the author's has a
 * `Host /usr/bin/ssh` - and a filesystem path is never a host worth offering.
 */
function isPathLike(alias: string): boolean {
  return alias.startsWith('/') || alias.startsWith('~') || alias.includes('/')
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
      current = { aliases: value.split(/\s+/).filter((a) => a && !isPattern(a) && !isPathLike(a)) }
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
    } else if (keyword === 'proxycommand') {
      current.proxyCommand = value
    }
  }

  return blocks
    .filter((b) => b.hostName && b.aliases.length > 0)
    .flatMap((b) =>
      b.aliases.map((alias) => ({ alias, hostName: b.hostName, user: b.user, port: b.port ?? 22 })),
    )
}

/** `--project "x"` / `--project x` / `--project=x`, quoted or not. */
function flag(command: string, name: string): string | null {
  const match = command.match(new RegExp(`--${name}[\\s=]+("[^"]+"|'[^']+'|[^\\s]+)`))
  if (!match) return null
  return match[1].replace(/^["']|["']$/g, '')
}

/**
 * IAP tunnel targets discovered from ~/.ssh/config.
 *
 * Every work VM here is reached through a `gcloud compute start-iap-tunnel`
 * ProxyCommand, and that line already carries the project and zone. So the
 * mobile app never needs those typed by hand: it asks a paired desktop what it
 * can see and offers the list.
 *
 * The instance name is `%h` in the ProxyCommand, which ssh expands to the host
 * being connected to - HostName when set, otherwise the alias.
 */
export function parseIapTargets(text: string): SshIapTarget[] {
  const targets: SshIapTarget[] = []
  let current: { aliases: string[]; hostName?: string; proxyCommand?: string } | null = null

  const flush = (): void => {
    if (!current?.proxyCommand || !current.proxyCommand.includes('start-iap-tunnel')) return
    const project = flag(current.proxyCommand, 'project')
    const zone = flag(current.proxyCommand, 'zone')
    if (!project || !zone) return
    for (const alias of current.aliases) {
      // %h expands to HostName when present, else the alias itself.
      const instance = current.hostName && !current.hostName.includes('%') ? current.hostName : alias
      targets.push({ alias, instance, project, zone })
    }
  }

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const sep = line.search(/[\s=]/)
    if (sep === -1) continue
    const keyword = line.slice(0, sep).toLowerCase()
    const value = line.slice(sep + 1).trim().replace(/^=\s*/, '')

    if (keyword === 'host') {
      flush()
      current = { aliases: value.split(/\s+/).filter((a) => a && !isPattern(a) && !isPathLike(a)) }
    } else if (!current) {
      continue
    } else if (keyword === 'hostname') {
      current.hostName = value
    } else if (keyword === 'proxycommand') {
      current.proxyCommand = value
    }
  }
  flush()
  return targets
}
