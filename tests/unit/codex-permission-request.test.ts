import { describe, expect, it } from 'vitest'
import { CODEX_PERMISSION_PATH_CAP, readCodexPermissionRequest } from '../../src/shared/codex-permission-request'
import { codexApprovalResult } from '../../src/main/provider/adapters/codex-adapter'

const METHOD = 'item/permissions/requestApproval'
const paths = (n: number) => Array.from({ length: n }, (_, i) => `/work/repo/very/long/directory/name-${i}/file.ts`)

describe('readCodexPermissionRequest', () => {
  it('lists every path of a long write list, on the card and in the plain-text detail', () => {
    const write = paths(CODEX_PERMISSION_PATH_CAP)
    const read = readCodexPermissionRequest({ permissions: { fileSystem: { write } }, reason: 'build' })
    if (!read.ok) throw new Error(read.reason)
    expect(read.view.sections).toEqual([{ label: 'Write access', items: write }])
    for (const path of write) expect(read.detail).toContain(path)
    expect(read.detail).toContain('Reason: build')
    expect(read.granted).toEqual({ fileSystem: { write } })
  })

  it('names entries, special paths, patterns and network access', () => {
    const permissions = {
      fileSystem: {
        entries: [
          { access: 'write', path: { type: 'path', path: '/a' } },
          { access: 'read', path: { type: 'glob_pattern', pattern: '**/*.md' } },
          { access: 'deny', path: { type: 'special', value: { kind: 'root' } } },
        ],
      },
      network: { enabled: true },
    }
    const read = readCodexPermissionRequest({ permissions })
    if (!read.ok) throw new Error(read.reason)
    expect(read.view.sections).toEqual([
      { label: 'Write access (entries)', items: ['/a'] },
      { label: 'Read access (entries)', items: ['**/*.md (pattern)'] },
      { label: 'No access (entries)', items: ['the whole file system'] },
      { label: 'Network access', items: ['On'] },
    ])
    expect(read.granted).toEqual(permissions)
  })

  it('refuses more paths than the cap', () => {
    const read = readCodexPermissionRequest({
      permissions: { fileSystem: { write: paths(CODEX_PERMISSION_PATH_CAP), read: ['/one-more'] } },
    })
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.reason).toContain(`${CODEX_PERMISSION_PATH_CAP + 1} paths`)
  })

  it('refuses a request over the text cap', () => {
    const read = readCodexPermissionRequest({ permissions: { fileSystem: { write: ['/' + 'x'.repeat(40_000)] } } })
    expect(read.ok).toBe(false)
  })

  it('refuses a field it cannot show', () => {
    expect(readCodexPermissionRequest({ permissions: { fileSystem: { execute: ['/bin'] } } }).ok).toBe(false)
    expect(readCodexPermissionRequest({ permissions: { macos: {} } }).ok).toBe(false)
    expect(readCodexPermissionRequest({}).ok).toBe(false)
  })
})

describe('codexApprovalResult for a permissions request', () => {
  it('grants nothing when the profile cannot be shown in full', () => {
    const params = { permissions: { fileSystem: { write: paths(CODEX_PERMISSION_PATH_CAP + 1) } } }
    expect(codexApprovalResult(METHOD, params, true)).toEqual({ permissions: {}, scope: 'turn' })
  })
})
