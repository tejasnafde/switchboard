/** Case-insensitive substring filter over ssh-config hosts (alias/host/user). */
import type { SshHost } from '@shared/machines'

export function filterSshHosts(hosts: SshHost[], query: string): SshHost[] {
  const q = query.trim().toLowerCase()
  if (!q) return hosts
  return hosts.filter((h) =>
    [h.alias, h.hostName ?? '', h.user ?? ''].some((f) => f.toLowerCase().includes(q)),
  )
}
