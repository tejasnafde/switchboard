import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sb-perf-summary-test-'))
  dirs.push(dir)
  return dir
}
function run(dir: string, files: string[] = []) {
  return execFileSync(process.execPath, [resolve('scripts/perf-summary.mjs'), ...files], {
    encoding: 'utf8',
    env: { ...process.env, SB_USER_DATA: dir, SWITCHBOARD_DATA_DIR: '' },
  })
}

describe('performance summary CLI discovery', () => {
  it('uses the desktop user-data override instead of a hard-coded home', () => {
    const dir = fixture()
    mkdirSync(join(dir, 'logs'))
    writeFileSync(join(dir, 'logs', 'switchboard-test.log'), '[perf] chat.open 450ms {}')
    expect(run(dir)).toContain('chat.open: count=1 p50=450ms')
  })
  it('discovers both desktop and headless data-directory overrides', () => {
    const desktop = fixture()
    const headless = fixture()
    mkdirSync(join(desktop, 'logs'))
    mkdirSync(join(headless, 'logs'))
    writeFileSync(join(desktop, 'logs', 'switchboard-desktop.log'), '[perf] desktop.span 450ms {}')
    writeFileSync(join(headless, 'logs', 'switchboard-headless.log'), '[perf] headless.span 600ms {}')
    const output = execFileSync(process.execPath, [resolve('scripts/perf-summary.mjs')], {
      encoding: 'utf8',
      env: { ...process.env, SB_USER_DATA: desktop, SWITCHBOARD_DATA_DIR: headless },
    })
    expect(output).toContain('desktop.span: count=1 p50=450ms')
    expect(output).toContain('headless.span: count=1 p50=600ms')
  })
  it('treats a missing log directory as empty input', () => {
    expect(run(fixture())).toBe('No performance spans found.\n')
  })
  it('preserves non-ENOENT directory failures', () => {
    const dir = fixture()
    writeFileSync(join(dir, 'logs'), 'not a directory')
    expect(() => run(dir)).toThrow()
  })
  it('does not count a log twice when desktop and headless directories alias', () => {
    const home = fixture()
    const desktop =
      process.platform === 'darwin'
        ? join(home, 'Library', 'Application Support', 'Switchboard')
        : join(home, 'config', 'Switchboard')
    mkdirSync(join(desktop, 'logs'), { recursive: true })
    writeFileSync(join(desktop, 'logs', 'switchboard-test.log'), '[perf] chat.open 450ms {}')
    symlinkSync(desktop, join(home, '.switchboard'), 'junction')
    const output = execFileSync(process.execPath, [resolve('scripts/perf-summary.mjs')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        APPDATA: join(home, 'config'),
        XDG_CONFIG_HOME: join(home, 'config'),
        SB_USER_DATA: '',
        SWITCHBOARD_DATA_DIR: '',
      },
    })
    expect(output).toContain('chat.open: count=1 p50=450ms')
  })
  it('reads explicit filenames without discovering the default directory', () => {
    const dir = fixture()
    const file = join(dir, 'explicit.log')
    writeFileSync(file, '[perf] ipc 250ms {"channel":"test"}')
    expect(run(dir, [file])).toContain('ipc: count=1 p50=250ms')
  })
})
