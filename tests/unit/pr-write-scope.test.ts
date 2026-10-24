/**
 * Phone pull request writes: the `pr-write` scope is never given at pairing,
 * only the desktop grants it, removal reaches live sockets at once, and every
 * phone write must carry the digest of what its confirm sheet showed, under a
 * write id the backend takes once.
 */
import { createMigratedDb } from './helpers/test-db'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/logger', () => ({
  createMainLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}))

const sessions = await import('../../src/main/backend/device-sessions')
const { FULL_SCOPES, PHONE_SCOPES, PR_WRITE_INACTIVE_MS, isChannelAllowed } =
  await import('../../src/shared/device-auth')
const { AppChannels, PullRequestPhoneChannels, PullRequestWriteChannels } =
  await import('../../src/shared/ipc-channels')
const { PHONE_PR_WRITE_DUPLICATE, PHONE_PR_WRITE_MISMATCH, phonePrWriteDigest, prTextLimitNote } =
  await import('../../src/shared/pull-request-phone-writes')
const { PR_TEXT_MAX_CHARS } = await import('../../src/shared/pull-request-writes')
const { withBackendRequestContext } = await import('../../src/main/backend/request-context')
const { phoneWrite } = await import('../../src/main/pull-requests/phone-write-gate')
const { PullRequestService } = await import('../../src/main/pull-requests/service')

import type { DeviceScope } from '../../src/shared/device-auth'
import type { PullRequestProvider } from '../../src/main/pull-requests/provider'
import type { PhonePrWriteSheet } from '../../src/shared/pull-request-phone-writes'
import type { PrConversation, PrRef } from '../../src/shared/pull-requests'

const PHONE_WRITER: DeviceScope[] = ['chat', 'pr-write']
const PHONE_WRITES = [
  PullRequestWriteChannels.REPLY,
  PullRequestWriteChannels.RESOLVE,
  PullRequestWriteChannels.COMMENT,
  PullRequestWriteChannels.SUBMIT_REVIEW,
  PullRequestPhoneChannels.WRITE_ACCOUNT,
]
const DESKTOP_ONLY_WRITES = [
  PullRequestWriteChannels.MERGE,
  PullRequestWriteChannels.DECLINE,
  PullRequestWriteChannels.ADD_REVIEWER,
  PullRequestWriteChannels.REMOVE_REVIEWER,
  PullRequestWriteChannels.RERUN_CHECK,
  PullRequestWriteChannels.INLINE_COMMENT,
  PullRequestWriteChannels.UNRESOLVE,
]

describe('the pr-write scope gate', () => {
  it('is not a pairing scope', () => {
    expect(PHONE_SCOPES).not.toContain('pr-write')
  })

  it('refuses every write to a phone without the grant', () => {
    for (const ch of [...PHONE_WRITES, ...DESKTOP_ONLY_WRITES]) expect(isChannelAllowed(PHONE_SCOPES, ch)).toBe(false)
  })

  it('opens only reply, resolve, comment, review and the account read to a granted phone', () => {
    for (const ch of PHONE_WRITES) expect(isChannelAllowed(PHONE_WRITER, ch)).toBe(true)
    for (const ch of DESKTOP_ONLY_WRITES) expect(isChannelAllowed(PHONE_WRITER, ch)).toBe(false)
  })

  it('keeps every write open to an admin device', () => {
    for (const ch of [...PHONE_WRITES, ...DESKTOP_ONLY_WRITES]) expect(isChannelAllowed(FULL_SCOPES, ch)).toBe(true)
  })

  it('never lets a phone grant itself', () => {
    expect(isChannelAllowed(PHONE_WRITER, AppChannels.MOBILE_DEVICE_PR_WRITE)).toBe(false)
    expect(isChannelAllowed(PHONE_SCOPES, AppChannels.DEVICE_SCOPES)).toBe(true)
  })
})

describe('granting and removing', () => {
  let token = ''
  function pair(): string {
    const { code } = sessions.createPairingCode()
    token = sessions.redeemPairingCode(code, 'iPhone', [...PHONE_SCOPES]).session ?? ''
    return sessions.listSessionViews()[0].id
  }

  beforeEach(() => {
    createMigratedDb()
    sessions.setScopeChangeListener(null)
  })

  it('stores the grant, tells live sockets, and removes it the same way', () => {
    const id = pair()
    const changes: Array<readonly DeviceScope[]> = []
    sessions.setScopeChangeListener((sid, scopes) => sid === id && changes.push(scopes))
    expect(sessions.setPrWriteScope(id, true)).toBe(true)
    expect(sessions.listSessionViews()[0].scopes).toEqual(['chat', 'pr-write'])
    expect(sessions.setPrWriteScope(id, false)).toBe(true)
    expect(sessions.listSessionViews()[0].scopes).toEqual(['chat'])
    expect(changes).toEqual([['chat', 'pr-write'], ['chat']])
  })

  it('applies a grant made while the phone was offline at its next connect', () => {
    const id = pair()
    sessions.setPrWriteScope(id, true)
    expect(sessions.authenticateSession(token)?.scopes).toEqual(['chat', 'pr-write'])
  })

  it('drops the grant from a device unseen for 30 days', () => {
    const id = pair()
    sessions.setPrWriteScope(id, true)
    const seen = sessions.listSessionViews()[0].lastSeenAt
    expect(sessions.authenticateSession(token, {}, seen + PR_WRITE_INACTIVE_MS - 1)?.scopes).toContain('pr-write')
    expect(sessions.authenticateSession(token, {}, seen + 2 * PR_WRITE_INACTIVE_MS)?.scopes).toEqual(['chat'])
    expect(sessions.listSessionViews()[0].scopes).toEqual(['chat'])
  })

  it('keeps a grant given to a device that was already away for a month', () => {
    const id = pair()
    const seen = sessions.listSessionViews()[0].lastSeenAt
    const later = seen + 2 * PR_WRITE_INACTIVE_MS
    sessions.setPrWriteScope(id, true, later)
    expect(sessions.authenticateSession(token, {}, later + 1000)?.scopes).toEqual(['chat', 'pr-write'])
  })

  it('refuses a revoked device', () => {
    const id = pair()
    sessions.revokeSession(id)
    expect(sessions.setPrWriteScope(id, true)).toBe(false)
  })
})

describe('the shown digest', () => {
  const sheet: PhonePrWriteSheet = {
    account: 'tejasnafde',
    ref: { host: 'github', owner: 'tejasnafde', name: 'switchboard', number: 161 },
    action: 'reply',
    conversationId: 'PRRT_1',
    event: null,
    text: 'Fixed in the next commit.',
    writeId: 'w_0123456789abcdef',
  }

  // Pinned: Android's PhonePrWrites.shownDigest must give the same values.
  it('matches the pinned vectors', () => {
    expect(phonePrWriteDigest(sheet)).toBe('80257400afe1485a')
    expect(
      phonePrWriteDigest({
        ...sheet,
        account: 'Jane Doe (jdoe)',
        ref: { host: 'bitbucket', owner: 'geoiq', name: 'ssg-bot-v2', number: 612 },
        action: 'review',
        conversationId: null,
        event: 'approve',
        text: 'Looks good. ✓ naïve',
      }),
    ).toBe('41ea42c76939646c')
  })

  it('changes with every field the sheet shows', () => {
    const base = phonePrWriteDigest(sheet)
    expect(phonePrWriteDigest({ ...sheet, account: 'someone' })).not.toBe(base)
    expect(phonePrWriteDigest({ ...sheet, ref: { ...sheet.ref, number: 162 } })).not.toBe(base)
    expect(phonePrWriteDigest({ ...sheet, conversationId: 'PRRT_2' })).not.toBe(base)
    expect(phonePrWriteDigest({ ...sheet, text: 'Fixed in the next commit' })).not.toBe(base)
    expect(phonePrWriteDigest({ ...sheet, writeId: 'w_0123456789abcdeg' })).not.toBe(base)
  })
})

describe('the character limit note', () => {
  it('names the host', () => {
    expect(prTextLimitNote('github', PR_TEXT_MAX_CHARS)).toBeNull()
    expect(prTextLimitNote('github', PR_TEXT_MAX_CHARS + 5)).toContain('GitHub takes at most 65,536')
    expect(prTextLimitNote('bitbucket', PR_TEXT_MAX_CHARS + 5)).toContain('Bitbucket sets its own limit')
    expect(prTextLimitNote('bitbucket', PR_TEXT_MAX_CHARS + 5)).toContain('Remove 5.')
  })
})

describe('a phone write through the gate', () => {
  const GH: PrRef = { host: 'github', owner: 'tejasnafde', name: 'switchboard', number: 161 }
  const thread: PrConversation = {
    id: 'PRRT_1',
    path: 'src/a.ts',
    line: 11,
    side: 'new',
    resolved: false,
    outdated: false,
    comments: [],
  }

  function setup(account = 'tejasnafde') {
    const reply = vi.fn(async () => {})
    const provider = {
      host: 'github',
      conversations: vi.fn(async () => [thread]),
      reply,
      writeAccount: vi.fn(async () => account),
    } as unknown as PullRequestProvider
    const service = new PullRequestService({
      listProjects: () => ['/p/switchboard'],
      readRemotes: async () => 'origin\thttps://github.com/tejasnafde/switchboard.git (fetch)',
      github: () => provider,
      bitbucket: () => null,
      bitbucketState: () => ({ state: 'none' }) as never,
    })
    const recorded: string[] = []
    const handler = phoneWrite(
      'reply',
      () => ({
        checkPhoneWrite: (ref, action, input) => service.checkPhoneWrite(ref, action, input),
        recordPrWrite: (id) => recorded.push(id),
      }),
      (ref, input) => service.reply(ref, input),
    )
    return { reply, handler, recorded }
  }

  const asDevice = <T>(scopes: DeviceScope[], fn: () => Promise<T>): Promise<T> =>
    withBackendRequestContext(
      { clientScope: 'device-session:x', transport: 'remote', deviceScopes: scopes, deviceSessionId: 'dev-1' },
      fn,
    )

  const body = 'Fixed in the next commit.'
  const writeId = 'w_0123456789abcdef'
  const shown = (over: Partial<PhonePrWriteSheet> = {}) =>
    phonePrWriteDigest({
      account: 'tejasnafde',
      ref: GH,
      action: 'reply',
      conversationId: 'PRRT_1',
      event: null,
      text: body,
      writeId,
      ...over,
    })

  it('refuses a phone write with no proof and sends nothing', async () => {
    const { reply, handler } = setup()
    const result = await asDevice(PHONE_WRITER, () => handler(GH, { conversationId: 'PRRT_1', body }))
    expect(result).toMatchObject({ ok: false, error: { message: PHONE_PR_WRITE_MISMATCH } })
    expect(reply).not.toHaveBeenCalled()
  })

  it('refuses a digest of different text and sends nothing', async () => {
    const { reply, handler } = setup()
    const result = await asDevice(PHONE_WRITER, () =>
      handler(GH, { conversationId: 'PRRT_1', body, phone: { shown: shown({ text: 'something else' }), writeId } }),
    )
    expect(result).toMatchObject({ ok: false, error: { message: PHONE_PR_WRITE_MISMATCH } })
    expect(reply).not.toHaveBeenCalled()
  })

  it('refuses when the desktop now posts as another account', async () => {
    const { reply, handler } = setup('someone-else')
    const result = await asDevice(PHONE_WRITER, () =>
      handler(GH, { conversationId: 'PRRT_1', body, phone: { shown: shown(), writeId } }),
    )
    expect(result).toMatchObject({ ok: false, error: { message: PHONE_PR_WRITE_MISMATCH } })
    expect(reply).not.toHaveBeenCalled()
  })

  it('posts a matching write once and refuses the same write id again', async () => {
    const { reply, handler, recorded } = setup()
    const input = { conversationId: 'PRRT_1', body, phone: { shown: shown(), writeId } }
    expect(await asDevice(PHONE_WRITER, () => handler(GH, input))).toMatchObject({ ok: true })
    expect(await asDevice(PHONE_WRITER, () => handler(GH, input))).toMatchObject({
      ok: false,
      error: { kind: 'conflict', message: PHONE_PR_WRITE_DUPLICATE },
    })
    expect(reply).toHaveBeenCalledTimes(1)
    expect(recorded).toEqual(['dev-1'])
  })

  it('lets two racing copies of one write through only once', async () => {
    const { reply, handler } = setup()
    const input = { conversationId: 'PRRT_1', body, phone: { shown: shown(), writeId } }
    const results = await Promise.all([
      asDevice(PHONE_WRITER, () => handler(GH, input)),
      asDevice(PHONE_WRITER, () => handler(GH, input)),
    ])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(reply).toHaveBeenCalledTimes(1)
  })

  it('lets a refused write retry under the same id once the sheet matches', async () => {
    const { reply, handler } = setup()
    const bad = { conversationId: 'PRRT_1', body, phone: { shown: shown({ text: 'x' }), writeId } }
    expect(await asDevice(PHONE_WRITER, () => handler(GH, bad))).toMatchObject({ ok: false })
    const good = { conversationId: 'PRRT_1', body, phone: { shown: shown(), writeId } }
    expect(await asDevice(PHONE_WRITER, () => handler(GH, good))).toMatchObject({ ok: true })
    expect(reply).toHaveBeenCalledTimes(1)
  })

  it('needs no proof from the desktop or an admin device', async () => {
    const { reply, handler } = setup()
    expect(await handler(GH, { conversationId: 'PRRT_1', body })).toMatchObject({ ok: true })
    expect(await asDevice([...FULL_SCOPES], () => handler(GH, { conversationId: 'PRRT_1', body }))).toMatchObject({
      ok: true,
    })
    expect(reply).toHaveBeenCalledTimes(2)
  })
})

describe('a phone review', () => {
  it('refuses line comments the phone never showed', async () => {
    const { phoneSheetFromInput } = await import('../../src/shared/pull-request-phone-writes')
    const ref: PrRef = { host: 'github', owner: 'o', name: 'r', number: 1 }
    const input = { event: 'approve', body: '', comments: [{ path: 'a', side: 'new', line: 1, body: 'x' }] }
    expect(phoneSheetFromInput(ref, 'review', input, 'w_0123456789abcdef')).toEqual({
      problem: 'Comment on lines from the desktop.',
    })
    expect(phoneSheetFromInput(ref, 'review', { ...input, comments: [] }, 'w_0123456789abcdef')).toMatchObject({
      event: 'approve',
      text: '',
    })
  })
})
