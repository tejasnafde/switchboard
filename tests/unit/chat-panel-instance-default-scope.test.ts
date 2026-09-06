/**
 * ChatPanel's "remember this as the machine default" write
 * (handleInstanceChange) used to persist under the single unscoped
 * `SETTING_DEFAULT_INSTANCE_ID` key. A Codex pick there would get read back
 * as the machine default for a brand-new Claude/OpenCode session too (see
 * tests/unit/session-defaults-instance-scope.test.ts for the read side).
 *
 * A full render of ChatPanel to exercise this is expensive and this repo has
 * no harness for it; the source-contract style below (see
 * dual-chat-component-contract.test.ts) is the established lightweight way
 * to pin wiring like this without one.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const panel = readFileSync(
  resolve(__dirname, '../../src/renderer/components/chat/ChatPanel.tsx'),
  'utf8',
)

describe('ChatPanel machine-default instance write is agent-scoped', () => {
  it('imports the scoped key helper', () => {
    expect(panel).toContain('defaultInstanceSettingKey')
  })

  it('writes the machine default under the per-agent scoped key, not the legacy global one', () => {
    const match = panel.match(/window\.api\.settings\s*\n?\s*\?\.set\?\.\(([^,]+),\s*nextInstanceId\)/)
    expect(match, 'expected a window.api.settings?.set?.(<key>, nextInstanceId) call').toBeTruthy()
    expect(match![1].trim()).toBe('defaultInstanceSettingKey(agentType)')
  })
})
