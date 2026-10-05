import { posix, win32 } from 'node:path'

export function perfLogDirectories(platform: string, home: string, env: Record<string, string | undefined>): string[] {
  const path = platform === 'win32' ? win32 : posix
  const overrides = [env.SB_USER_DATA, env.SWITCHBOARD_DATA_DIR].filter((dir): dir is string => Boolean(dir))
  if (overrides.length) return overrides.map((dir) => path.join(dir, 'logs'))
  const appData = platform === 'win32'
    ? env.APPDATA || path.join(home, 'AppData', 'Roaming')
    : platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : env.XDG_CONFIG_HOME || path.join(home, '.config')
  return [
    path.join(appData, 'Switchboard', 'logs'),
    path.join(appData, 'switchboard', 'logs'),
    path.join(home, '.switchboard', 'logs'),
  ]
}
