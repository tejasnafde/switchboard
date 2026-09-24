/**
 * Native menu accelerators reach the renderer over IPC, past the confirm's
 * key guard. Every menu receiver in App must wait out an open confirm.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const app = readFileSync(join(__dirname, '../../src/renderer/App.tsx'), 'utf8')
const preload = readFileSync(join(__dirname, '../../src/preload/index.ts'), 'utf8')

describe('menu IPC while a confirm is open', () => {
  it('wraps every menu receiver the preload exposes', () => {
    const receivers = ['onOpenSettings', 'onOpenChatBeside', 'onClosePaneOrWindow']
    for (const name of receivers) {
      expect(preload).toContain(`${name}: (callback`)
      expect(app).toMatch(new RegExp(`window\\.api\\.${name}\\(unlessConfirmOpen\\(`))
    }
  })

  it('knows every channel main sends from the menu or an intercepted key', () => {
    const main = readFileSync(join(__dirname, '../../src/main/index.ts'), 'utf8')
    const sent = [...main.matchAll(/webContents\.send\('(app:[a-z-]+)'/g)].map((match) => match[1])
    // Window state, not a user action: it only restyles translucency.
    const notActions = ['app:fullscreen-changed']
    // A new menu channel needs a guarded receiver above before it joins this list.
    expect(new Set(sent.filter((channel) => !notActions.includes(channel))))
      .toEqual(new Set(['app:open-settings', 'app:open-chat-beside', 'app:close-pane-or-window']))
  })
})
