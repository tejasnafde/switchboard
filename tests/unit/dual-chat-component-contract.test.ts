import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8')

describe('dual-chat component contract', () => {
  const app = read('../../src/renderer/App.tsx')
  const panel = read('../../src/renderer/components/chat/ChatPanel.tsx')
  const input = read('../../src/renderer/components/chat/ChatInput.tsx')
  const statusBar = read('../../src/renderer/components/StatusBar.tsx')
  const sidebar = read('../../src/renderer/components/sidebar/Sidebar.tsx')
  const main = read('../../src/main/index.ts')
  const preload = read('../../src/preload/index.ts')
  const terminalPane = read('../../src/renderer/components/terminal/TerminalPane.tsx')
  const terminalSessionPane = read('../../src/renderer/components/terminal/TerminalSessionPane.tsx')

  it('uses unambiguous slot and session attributes on chat roots', () => {
    expect(panel).toContain('data-chat-slot={chatSlot}')
    expect(panel).toContain('data-session-id={sessionId ?? undefined}')
    expect(panel).toContain('onFocusCapture={focusSlot}')
    expect(panel).toContain('onPointerDown={focusSlot}')
    expect(panel).toContain('chatSlot ? slotSessionId : s.activeSessionId')
  })

  it('registers composers by session and has no first-match textarea routing', () => {
    expect(input).toContain('registerComposer(sessionId')
    expect(app).not.toMatch(/document\.querySelector[^\n]*textarea/)
    expect(panel).not.toMatch(/document\.querySelector\(['"]textarea/)
  })

  it('exposes the companion-session binding on the persistent status surface', () => {
    expect(statusBar).toContain('data-status-bar')
    expect(statusBar).toContain('data-session-id={activeSessionId ?? undefined}')
  })

  it('subscribes to slot ids as stable primitives for React external-store snapshots', () => {
    expect(sidebar).not.toContain('useLayoutStore((s) => [s.primarySessionId, s.secondarySessionId])')
    expect(sidebar).toContain('useLayoutStore((s) => s.primarySessionId)')
    expect(sidebar).toContain('useLayoutStore((s) => s.secondarySessionId)')
  })

  it('keeps both slot panels mounted and changes only their presentation', () => {
    expect(app).toContain('data-chat-workspace')
    expect(app).toContain('chatSlot="primary"')
    expect(app).toContain('chatSlot="secondary"')
    expect(app).toContain('data-chat-presentation={chatPresentation}')
    expect(app).toContain("display: activeTerminalPaneId ? 'none' : 'flex'")
    expect(app).not.toMatch(/activeTerminalPaneId\s*\?\s*\(\s*<TerminalSessionPane/)
  })

  it('does not place terminal summaries in the secondary chat slot', () => {
    expect(app).toContain("placement === 'beside' && session.agentType !== 'terminal'")
  })

  it('surfaces a header open-beside action with explanatory copy', () => {
    expect(panel).toContain('Compare or delegate with two chats side by side')
    expect(panel).toContain('Open beside')
    expect(app).toContain('handleOpenLoadedSessionBeside')
    expect(app).not.toContain('onPick={(id) => openChatBeside(id)}')
  })

  it('exposes the same open-beside chord through the native Chat menu', () => {
    expect(main).toContain("label: 'Open Chat Beside…'")
    expect(main).toContain("accelerator: 'CmdOrCtrl+Shift+\\\\'")
    expect(preload).toContain('onOpenChatBeside')
    expect(app).toContain('window.api.onOpenChatBeside')
    expect(app).toContain('toggleDualChatWorkspace')
    expect(app.match(/toggleDualChatWorkspace\(/g)).toHaveLength(3)
  })

  it('marks every terminal surface with its authoritative owning session', () => {
    expect(terminalPane).toContain('data-context-source="terminal"')
    expect(terminalPane).toContain('data-session-id={props.sessionId}')
    expect(terminalSessionPane).toContain('data-context-source="terminal"')
    expect(terminalSessionPane).toContain('data-session-id={sessionId}')
    expect(app).toContain('<TerminalSessionPane paneId={activeTerminalPaneId} sessionId={companionAgentSessionId!}')
  })
})
