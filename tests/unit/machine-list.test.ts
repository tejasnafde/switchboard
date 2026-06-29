/**
 * buildMachineList: the sidebar's machine display model. Local is synthesized,
 * pinned first, always connected; remotes follow in sortOrder, each carrying its
 * live connection status (default offline).
 */
import { describe, it, expect } from 'vitest'
import { buildMachineList } from '../../src/renderer/components/sidebar/machineList'
import type { Machine } from '@shared/machines'

const mk = (over: Partial<Machine>): Machine => ({
  id: 'm1', name: 'prod-vm', sshAlias: null, sshHost: '10.0.0.1', sshUser: 'ubuntu',
  sshPort: 22, sortOrder: 0, createdAt: 0, updatedAt: 0, ...over,
})

describe('buildMachineList', () => {
  it('pins a synthesized local machine first, always connected', () => {
    const list = buildMachineList([], { localName: 'This Mac', connections: {} })
    expect(list).toEqual([{ id: 'local', name: 'This Mac', kind: 'local', status: 'connected' }])
  })

  it('appends remotes after local in sortOrder, defaulting to offline', () => {
    const remotes = [mk({ id: 'b', name: 'beta', sortOrder: 1 }), mk({ id: 'a', name: 'alpha', sortOrder: 0 })]
    const list = buildMachineList(remotes, { localName: 'This Mac', connections: {} })
    expect(list.map((m) => m.id)).toEqual(['local', 'a', 'b'])
    expect(list.slice(1).every((m) => m.kind === 'remote' && m.status === 'offline')).toBe(true)
  })

  it('reflects live connection status per machine', () => {
    const remotes = [mk({ id: 'a', sortOrder: 0 }), mk({ id: 'b', sortOrder: 1 })]
    const list = buildMachineList(remotes, {
      localName: 'This Mac',
      connections: { a: 'connected', b: 'connecting' },
    })
    expect(list.find((m) => m.id === 'a')!.status).toBe('connected')
    expect(list.find((m) => m.id === 'b')!.status).toBe('connecting')
  })

  it('carries ssh fields through for display', () => {
    const list = buildMachineList([mk({ id: 'a', sshUser: 'deploy', sshHost: 'h.dev' })], {
      localName: 'Local',
      connections: {},
    })
    expect(list[1]).toMatchObject({ kind: 'remote', sshUser: 'deploy', sshHost: 'h.dev' })
  })
})
