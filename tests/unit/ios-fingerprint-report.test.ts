import { describe, expect, it } from 'vitest'
import { fingerprintSummary, fingerprintMetadata } from '../../scripts/ios-fingerprint-report.mjs'

describe('iOS native compatibility report', () => {
  it('reports compatibility only when the two native hashes match', () => {
    expect(fingerprintSummary({ hash: 'abc' }, { hash: 'abc' }, [])).toContain('OTA-compatible with this base')
    expect(fingerprintSummary({ hash: 'abc' }, { hash: 'def' }, [])).toContain('new iOS binary required')
  })
  it('lists changed, added and removed native inputs without their contents', () => {
    const report = fingerprintSummary({ hash: 'abc' }, { hash: 'def' }, [
      { op: 'changed', afterSource: { type: 'contents', id: 'expoConfig', contents: 'private-value' } },
      { op: 'added', addedSource: { type: 'dir', filePath: 'modules/socket/ios' } },
      { op: 'removed', removedSource: { type: 'file', filePath: 'old.plugin.js' } },
    ])
    expect(report).toContain('changed: <code>expoConfig</code>')
    expect(report).toContain('added: <code>modules/socket/ios</code>')
    expect(report).toContain('removed: <code>old.plugin.js</code>')
    expect(report).not.toContain('private-value')
    expect(report).toContain('does not establish compatibility with every installed store binary')
  })
  it('escapes source names supplied by a pull request', () => {
    expect(
      fingerprintSummary({ hash: 'a' }, { hash: 'b' }, [
        { op: 'added', addedSource: { type: 'file', filePath: '<img src=x>\n# forged' } },
      ]),
    ).toContain('&lt;img src=x&gt; # forged')
  })
  it('keeps only input identity, hash and reasons in artifacts', () => {
    expect(
      fingerprintMetadata({
        hash: 'a',
        sources: [
          {
            type: 'contents',
            id: 'expoConfig',
            hash: 'b',
            contents: 'private',
            reasons: ['config'],
            debugInfo: { contents: 'private' },
          },
        ],
      }),
    ).toEqual({ hash: 'a', sources: [{ type: 'contents', id: 'expoConfig', hash: 'b', reasons: ['config'] }] })
  })
})
