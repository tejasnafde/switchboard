/**
 * Search reads SETTING_ROWS, and the pages render rows from the same
 * definitions. This pins that every indexed row is actually on its page, and
 * every row a page renders is indexed, so search cannot drift from what the
 * page shows. `renderToStaticMarkup` runs no effects, so no IPC is touched.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SettingsPageBody } from '../../src/renderer/components/SettingsPage'
import { SETTINGS_PAGES, SETTING_ROWS, PRIVACY_POLICY_URL } from '../../src/renderer/components/settings/settings-rows'
import { SETTING_BINDING_IDS } from '../../src/renderer/components/settings/setting-values'

describe('Settings pages', () => {
  for (const page of SETTINGS_PAGES) {
    it(`${page.title} renders exactly its indexed rows`, () => {
      const html = renderToStaticMarkup(createElement(SettingsPageBody, { page: page.id }))
      const rendered = [...html.matchAll(/data-setting-row="([^"]+)"/g)].map((m) => m[1])
      const indexed = SETTING_ROWS.filter((row) => row.page === page.id).map((row) => row.id)
      expect(rendered.sort()).toEqual(indexed.sort())
    })
  }

  it('links the privacy policy as a plain external link', () => {
    const html = renderToStaticMarkup(createElement(SettingsPageBody, { page: 'general' }))
    expect(html).toContain(`href="${PRIVACY_POLICY_URL}"`)
  })

  it('binds every row that has a default, and nothing else', () => {
    const withDefault = SETTING_ROWS.filter((row) => row.defaultValue !== undefined).map((row) => row.id)
    expect([...SETTING_BINDING_IDS].sort()).toEqual(withDefault.sort())
  })
})
