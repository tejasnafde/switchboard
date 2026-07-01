import { describe, it, expect } from 'vitest'
import { filterSshHosts } from '../../src/renderer/components/sidebar/sshHostFilter'
import type { SshHost } from '@shared/machines'

const hosts: SshHost[] = [
  { alias: 'geoiq-ssg-bot-stg-in', hostName: 'geoiq-ssg-bot-stg-in', user: 'tejas_geoiq_io', port: 22 },
  { alias: 'prod-db', hostName: '10.0.0.4', user: 'ubuntu', port: 22 },
  { alias: 'giq-stg', hostName: 'compute.7364', port: 22 },
]

describe('filterSshHosts', () => {
  it('returns all when the query is blank', () => {
    expect(filterSshHosts(hosts, '   ')).toHaveLength(3)
  })
  it('matches on alias', () => {
    expect(filterSshHosts(hosts, 'ssg').map((h) => h.alias)).toEqual(['geoiq-ssg-bot-stg-in'])
  })
  it('matches on hostName and user, case-insensitively', () => {
    expect(filterSshHosts(hosts, '10.0.0').map((h) => h.alias)).toEqual(['prod-db'])
    expect(filterSshHosts(hosts, 'UBUNTU').map((h) => h.alias)).toEqual(['prod-db'])
  })
  it('returns none when nothing matches', () => {
    expect(filterSshHosts(hosts, 'zzz')).toEqual([])
  })
})
