import { describe, expect, it } from 'vitest'
import { perfLogDirectories } from '../../src/main/perf-log-paths'

describe('logger data paths for performance summary', () => {
  it('uses APPDATA and product name on Windows, and includes the development name', () => {
    expect(perfLogDirectories('win32', 'C:\\Users\\Test', { APPDATA: 'D:\\Roaming' })).toEqual([
      'D:\\Roaming\\Switchboard\\logs', 'D:\\Roaming\\switchboard\\logs', 'C:\\Users\\Test\\.switchboard\\logs',
    ])
  })
  it('uses XDG_CONFIG_HOME on Linux', () => {
    expect(perfLogDirectories('linux', '/home/test', { XDG_CONFIG_HOME: '/config' })).toEqual([
      '/config/Switchboard/logs', '/config/switchboard/logs', '/home/test/.switchboard/logs',
    ])
  })
  it('uses macOS Application Support and includes headless logs', () => {
    expect(perfLogDirectories('darwin', '/home/test', {})).toEqual([
      '/home/test/Library/Application Support/Switchboard/logs',
      '/home/test/Library/Application Support/switchboard/logs', '/home/test/.switchboard/logs',
    ])
  })
  it('honors the desktop and headless data-dir overrides', () => {
    expect(perfLogDirectories('linux', '/home/test', { SB_USER_DATA: '/desktop' })).toEqual(['/desktop/logs'])
    expect(perfLogDirectories('linux', '/home/test', { SWITCHBOARD_DATA_DIR: '/server' })).toEqual(['/server/logs'])
  })
})
