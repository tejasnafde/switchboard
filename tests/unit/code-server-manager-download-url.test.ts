import { describe, it, expect } from 'vitest'
import { resolveDownloadAsset, CODE_SERVER_VERSION } from '../../src/main/ide/code-server-manager'

describe('resolveDownloadAsset', () => {
  it('maps darwin/arm64 to the macos-arm64 tarball', () => {
    const a = resolveDownloadAsset('4.127.0', 'darwin', 'arm64')
    expect(a.assetName).toBe('code-server-4.127.0-macos-arm64.tar.gz')
    expect(a.url).toBe(
      'https://github.com/coder/code-server/releases/download/v4.127.0/code-server-4.127.0-macos-arm64.tar.gz'
    )
  })

  it('maps darwin/x64 to macos-amd64', () => {
    expect(resolveDownloadAsset('4.127.0', 'darwin', 'x64').assetName).toBe(
      'code-server-4.127.0-macos-amd64.tar.gz'
    )
  })

  it('maps linux/x64 and linux/arm64', () => {
    expect(resolveDownloadAsset('4.127.0', 'linux', 'x64').assetName).toBe(
      'code-server-4.127.0-linux-amd64.tar.gz'
    )
    expect(resolveDownloadAsset('4.127.0', 'linux', 'arm64').assetName).toBe(
      'code-server-4.127.0-linux-arm64.tar.gz'
    )
  })

  it('throws a descriptive error for unsupported platforms', () => {
    expect(() => resolveDownloadAsset('4.127.0', 'win32', 'x64')).toThrow(/unsupported/i)
    expect(() => resolveDownloadAsset('4.127.0', 'linux', 'ia32')).toThrow(/unsupported/i)
  })

  it('pins a default version', () => {
    expect(CODE_SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
