/**
 * Phone pull request writes on the PR screen: the write UI shows only with
 * the backend capability and the `pr-write` scope; Post asks for the device
 * unlock and sends the digest of exactly the shown trimmed text with a fresh
 * write id; a refused unlock sends nothing; a rejected send is never re-sent
 * and says it is not sure; 'not permitted' says the scope was removed.
 */
import React from 'react'
import { act } from 'react-test-renderer'
import { phonePrWriteDigest, PHONE_PR_WRITE_COPY } from '@shared/pull-request-phone-writes'
import type { PrConversation, PrDetail, PrSummary } from '@shared/pull-requests'
import PullRequestScreen from '../PullRequestScreen'
import { renderComponent } from '../../test/render'
import type { DeviceUnlock } from '../../lib/device-unlock'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const cases = require('../../../../../tests/fixtures/phone-pr-cases.json') as { prs: Record<string, PrSummary> }

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}))

const mockUnlock = jest.fn<Promise<DeviceUnlock>, []>()
jest.mock('../../lib/device-unlock', () => ({ unlockToPost: () => mockUnlock() }))

let mockByte = 0
jest.mock('expo-crypto', () => ({
  getRandomBytes: (n: number) => new Uint8Array(n).fill(++mockByte),
}))

const pr: PrDetail = {
  ...cases.prs.failed,
  viewer: { isAuthor: false, isRequestedReviewer: true, hasReviewed: false, hasCommented: false },
  description: '',
  headSha: null,
  mergeBlockers: [],
  mergeStrategies: ['merge_commit'],
  activity: [],
  checkList: [],
  viewerCanManage: false,
}

const thread: PrConversation = {
  id: 'PRRT_1',
  path: 'src/main/backend/device-sessions.ts',
  line: 88,
  side: 'new',
  resolved: false,
  outdated: false,
  comments: [
    {
      id: 'c1',
      author: { login: 'mira-k', displayName: 'Mira' } as PrConversation['comments'][number]['author'],
      body: 'Should the token hash use a pepper too?',
      createdAt: 1,
      url: null,
    },
  ],
}

const mockClient = {
  capable: true,
  scopes: ['chat', 'pr-write'] as string[],
  supportsCapability: (name: string): boolean | undefined =>
    name === 'pr_write_scope_v1' ? mockClient.capable : undefined,
  pullRequestDetail: jest.fn(async () => ({ ok: true, data: pr })),
  pullRequestChats: jest.fn(async () => []),
  onPullRequestLinksChanged: () => () => undefined,
  pullRequestConversations: jest.fn(async () => ({ ok: true, data: [thread] })),
  deviceScopes: jest.fn(async (): Promise<string[]> => mockClient.scopes),
  pullRequestWriteAccount: jest.fn(async () => ({ ok: true, data: { account: 'tejasnafde' } })),
  pullRequestWrite: jest.fn(),
}

jest.mock('../../stores/connections', () => {
  const state = { status: { m1: 'connected' } }
  const useConnectionsStore = (selector: (s: typeof state) => unknown) => selector(state)
  useConnectionsStore.getState = () => state
  return { getClient: () => mockClient, useConnectionsStore }
})

const navigation = { addListener: jest.fn(() => () => undefined), navigate: jest.fn() }

async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => await Promise.resolve())
}

async function mount() {
  const view = renderComponent(
    <PullRequestScreen
      // The screen reads only these route and navigation fields.
      route={{ key: 'k', name: 'PullRequest', params: { connectionId: 'm1', ref: pr.ref } } as never}
      navigation={navigation as never}
    />,
  )
  await flush()
  return view
}

const byTestId = (view: ReturnType<typeof renderComponent>, testID: string) =>
  view.root.findAll((n) => n.props.testID === testID, { deep: false })

async function press(view: ReturnType<typeof renderComponent>, testID: string) {
  const [node] = byTestId(view, testID)
  if (!node) throw new Error(`no ${testID}`)
  await act(async () => node.props.onPress())
  await flush()
}

async function openReplySheet(text: string) {
  const view = await mount()
  await press(view, 'pr-reply-PRRT_1')
  const [input] = byTestId(view, 'pr-write-input')
  await act(async () => input.props.onChangeText(text))
  await press(view, 'pr-write-continue')
  return view
}

beforeEach(() => {
  mockClient.capable = true
  mockClient.scopes = ['chat', 'pr-write']
  mockUnlock.mockResolvedValue('ok')
  mockClient.pullRequestWrite.mockReset()
})

describe('pull request writes on the phone', () => {
  it('shows no write UI and no threads without the capability', async () => {
    mockClient.capable = false
    const view = await mount()
    expect(byTestId(view, 'pr-conversations')).toHaveLength(0)
    expect(byTestId(view, 'pr-comment')).toHaveLength(0)
    expect(mockClient.deviceScopes).not.toHaveBeenCalled()
  })

  it('lists threads read-only with the no-scope note when the phone lacks pr-write', async () => {
    mockClient.scopes = ['chat']
    const view = await mount()
    expect(byTestId(view, 'pr-thread-PRRT_1')).toHaveLength(1)
    expect(byTestId(view, 'pr-reply-PRRT_1')).toHaveLength(0)
    expect(byTestId(view, 'pr-comment')).toHaveLength(0)
    expect(view.texts().join('')).toContain(PHONE_PR_WRITE_COPY.noScopeBody)
    expect(view.texts()).toContain('Merge on desktop. ')
  })

  it('reads the scopes again when the screen regains focus', async () => {
    await mount()
    const calls = mockClient.deviceScopes.mock.calls.length
    const focus = (navigation.addListener.mock.calls as unknown as Array<[string, () => void]>).find(
      ([name]) => name === 'focus',
    )
    await act(async () => focus?.[1]())
    await flush()
    expect(mockClient.deviceScopes.mock.calls.length).toBeGreaterThan(calls)
  })

  it('posts the digest of exactly the shown trimmed text with a valid write id', async () => {
    mockClient.pullRequestWrite.mockResolvedValue({ ok: true, data: { refresh: ['conversations'] } })
    const view = await openReplySheet('  Fixed in the next commit.\n ')
    expect(view.texts()).toContain('Fixed in the next commit.')
    expect(view.texts()).toContain('tejasnafde')
    await press(view, 'pr-write-post')

    expect(mockUnlock).toHaveBeenCalledTimes(1)
    expect(mockClient.pullRequestWrite).toHaveBeenCalledTimes(1)
    const [channel, ref, input] = mockClient.pullRequestWrite.mock.calls[0]
    expect(channel).toBe('pull-requests:reply')
    expect(ref).toEqual(pr.ref)
    expect(input.body).toBe('Fixed in the next commit.')
    expect(input.phone.writeId).toMatch(/^[A-Za-z0-9_-]{16,64}$/)
    expect(input.phone.shown).toBe(
      phonePrWriteDigest({
        account: 'tejasnafde',
        ref: pr.ref,
        action: 'reply',
        conversationId: 'PRRT_1',
        event: null,
        text: 'Fixed in the next commit.',
        writeId: input.phone.writeId,
      }),
    )
    expect(byTestId(view, 'pr-write-sheet')).toHaveLength(0)
    expect(view.texts()).toContain('Posted')
  })

  it.each<DeviceUnlock>(['cancelled', 'unavailable', 'no-passcode'])(
    'sends nothing when the unlock is %s',
    async (unlock) => {
      mockUnlock.mockResolvedValue(unlock)
      const view = await openReplySheet('Fixed.')
      await press(view, 'pr-write-post')
      expect(mockClient.pullRequestWrite).not.toHaveBeenCalled()
      expect(byTestId(view, 'pr-write-sheet')).toHaveLength(1)
      if (unlock === 'no-passcode') expect(view.texts()).toContain(PHONE_PR_WRITE_COPY.noPasscode)
    },
  )

  it('never re-sends a rejected write and shows the not-sure sheet', async () => {
    mockClient.pullRequestWrite.mockRejectedValue(new Error('request timed out'))
    const view = await openReplySheet('Fixed.')
    await press(view, 'pr-write-post')
    expect(view.texts()).toContain(PHONE_PR_WRITE_COPY.notSureTitle)
    expect(view.texts()).toContain(PHONE_PR_WRITE_COPY.notSureBody)
    expect(byTestId(view, 'pr-write-post')).toHaveLength(0)
    const conversationReads = mockClient.pullRequestConversations.mock.calls.length
    await press(view, 'pr-write-check-thread')
    expect(mockClient.pullRequestWrite).toHaveBeenCalledTimes(1)
    expect(byTestId(view, 'pr-write-sheet')).toHaveLength(0)
    expect(mockClient.pullRequestConversations.mock.calls.length).toBeGreaterThan(conversationReads)
    // The draft is kept for the next reply.
    await press(view, 'pr-reply-PRRT_1')
    expect(byTestId(view, 'pr-write-input')[0].props.value).toBe('Fixed.')
  })

  it('shows the removed copy and hides the write buttons on not permitted', async () => {
    mockClient.pullRequestWrite.mockRejectedValue(new Error('not permitted: pull-requests:reply'))
    const view = await openReplySheet('Fixed.')
    mockClient.scopes = ['chat']
    await press(view, 'pr-write-post')
    expect(view.texts()).toContain(PHONE_PR_WRITE_COPY.removed)
    expect(byTestId(view, 'pr-write-post')).toHaveLength(0)
    expect(byTestId(view, 'pr-reply-PRRT_1')).toHaveLength(0)
    expect(byTestId(view, 'pr-comment')).toHaveLength(0)
    expect(mockClient.pullRequestWrite).toHaveBeenCalledTimes(1)
  })

  it('shows a refusal on the sheet and mints a new write id for the next Post', async () => {
    mockClient.pullRequestWrite.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'stale', host: 'github', message: 'The thread is gone.' },
    })
    mockClient.pullRequestWrite.mockResolvedValueOnce({ ok: true, data: { refresh: [] } })
    const view = await openReplySheet('Fixed.')
    await press(view, 'pr-write-post')
    expect(view.texts()).toContain('The thread is gone.')
    expect(byTestId(view, 'pr-write-sheet')).toHaveLength(1)
    await press(view, 'pr-write-post')
    expect(mockClient.pullRequestWrite).toHaveBeenCalledTimes(2)
    const first = mockClient.pullRequestWrite.mock.calls[0][2].phone
    const second = mockClient.pullRequestWrite.mock.calls[1][2].phone
    expect(second.writeId).not.toBe(first.writeId)
    expect(second.shown).not.toBe(first.shown)
  })
})
