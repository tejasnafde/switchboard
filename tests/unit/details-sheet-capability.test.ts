/**
 * The phones' Details sheet (`details_sheet_v1`): the backend advertises it,
 * and a phone's scopes reach every read the sheet makes.
 */
import { describe, expect, it } from 'vitest'
import { DETAILS_SHEET_CAPABILITY } from '../../src/shared/chat-details'
import { isChannelAllowed, PHONE_SCOPES } from '../../src/shared/device-auth'
import { GitChannels, ProviderInstanceChannels, PullRequestChannels } from '../../src/shared/ipc-channels'
import { BACKEND_CAPABILITIES } from '../../src/shared/ws-protocol'

describe('details_sheet_v1', () => {
  it('is advertised in the ready frame', () => {
    expect(BACKEND_CAPABILITIES).toContain(DETAILS_SHEET_CAPABILITY)
  })

  it.each([
    GitChannels.CURRENT_BRANCH,
    GitChannels.DIFF_STAT,
    PullRequestChannels.LINKS,
    PullRequestChannels.LIST,
    ProviderInstanceChannels.USAGE,
  ])('lets a phone read %s', (channel) => {
    expect(isChannelAllowed(PHONE_SCOPES, channel)).toBe(true)
  })
})
