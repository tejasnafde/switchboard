import { describe, it, expect, vi, beforeEach } from 'vitest'

const execFile = vi.fn()
const findClaudeBin = vi.fn()

vi.mock('child_process', () => ({ execFile: (...args: unknown[]) => execFile(...args) }))
vi.mock('../../src/main/provider/adapters/claude-adapter', () => ({ findClaudeBin: () => findClaudeBin() }))
vi.mock('../../src/main/logger', () => ({
  createMainLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

const { claudeLaunchPath, refreshClaudeTokenWithoutTurn } = await import('../../src/main/provider/usage/claude-cli-refresh')

const SHIM = 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd'
const EXE = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'

describe('claudeLaunchPath', () => {
  it('launches a Windows npm shim through its native exe, never a shell', () => {
    expect(claudeLaunchPath(SHIM, 'win32', (p) => p === EXE)).toBe(EXE)
    expect(claudeLaunchPath(SHIM.replace('.cmd', '.ps1'), 'win32', (p) => p === EXE)).toBe(EXE)
  })

  it('refuses a Windows shim with no native target', () => {
    expect(claudeLaunchPath(SHIM, 'win32', () => false)).toBeNull()
  })

  it('leaves a real exe and every non-Windows path alone', () => {
    expect(claudeLaunchPath('C:\\tools\\claude.exe', 'win32', () => false)).toBe('C:\\tools\\claude.exe')
    expect(claudeLaunchPath('/opt/homebrew/bin/claude', 'darwin', () => false)).toBe('/opt/homebrew/bin/claude')
  })
})

describe('runClaude', () => {
  beforeEach(() => {
    execFile.mockReset().mockImplementation((_bin, _args, _opts, cb: (err: Error | null) => void) => cb(null))
    findClaudeBin.mockReset()
  })

  it('runs the resolved binary without a shell', async () => {
    findClaudeBin.mockReturnValue('/usr/local/bin/claude')
    expect(await refreshClaudeTokenWithoutTurn({ CLAUDE_CONFIG_DIR: '/tmp/x' })).toBe(true)
    const [bin, args, opts] = execFile.mock.calls[0] as [string, string[], { shell?: unknown }]
    expect(bin).toBe('/usr/local/bin/claude')
    expect(args).toEqual(['mcp', 'list'])
    expect(opts.shell).toBeUndefined()
  })

  it('reports failure instead of spawning when the binary is missing', async () => {
    findClaudeBin.mockReturnValue(undefined)
    expect(await refreshClaudeTokenWithoutTurn({})).toBe(false)
    expect(execFile).not.toHaveBeenCalled()
  })
})
