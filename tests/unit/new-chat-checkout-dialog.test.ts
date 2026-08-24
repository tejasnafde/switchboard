import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import * as checkoutDialog from '../../src/renderer/components/NewChatCheckoutDialog'

const appSource = readFileSync(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8')
const settingsSource = readFileSync(new URL('../../src/renderer/components/SettingsModal.tsx', import.meta.url), 'utf8')

describe('NewChatCheckoutDialog', () => {
  it('requires an explicit accessible checkout choice for the captured project and machine', () => {
    expect(typeof checkoutDialog.NewChatCheckoutDialog).toBe('function')

    const markup = renderToStaticMarkup(createElement(checkoutDialog.NewChatCheckoutDialog, {
      projectPath: '/projects/switchboard',
      machineId: 'build-mac',
      recommendedCheckout: 'worktree',
      onChoose: vi.fn(),
      onCancel: vi.fn(),
    }))

    expect(markup).toContain('role="dialog"')
    expect(markup).toContain('aria-modal="true"')
    expect(markup).toContain('Choose where to start')
    expect(markup).toContain('switchboard')
    expect(markup).toContain('build-mac')
    expect(markup).toContain('New worktree')
    expect(markup).toContain('Project checkout')
    expect(markup).toContain('Recommended')
  })

  it('uses the preference only to mark one recommended option', () => {
    expect(typeof checkoutDialog.describeNewChatCheckoutChoices).toBe('function')

    expect(checkoutDialog.describeNewChatCheckoutChoices('worktree')).toEqual([
      expect.objectContaining({ checkout: 'worktree', recommended: true }),
      expect.objectContaining({ checkout: 'project', recommended: false }),
    ])
    expect(checkoutDialog.describeNewChatCheckoutChoices('project')).toEqual([
      expect.objectContaining({ checkout: 'worktree', recommended: false }),
      expect.objectContaining({ checkout: 'project', recommended: true }),
    ])
  })

  it('gates Desktop new-chat submission on the dialog choice', () => {
    expect(appSource).toContain('<NewChatCheckoutDialog')
    expect(appSource).toContain('confirmNewChatCheckout')
    expect(appSource).toContain('cancelNewChatCheckout')
  })

  it('describes the saved setting as a recommendation rather than an automatic default', () => {
    expect(settingsSource).toContain('Recommended workspace')
    expect(settingsSource).toContain('You still choose for every new thread.')
  })
})
