/**
 * The link tools of the Switchboard MCP server: an agent links, unlinks and
 * lists the chat's pull requests. A link is a local write, so no card; plan
 * mode refuses link and unlink; the list runs in every mode. Only a PR of a
 * repository the chat's project covers may be linked.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/logger', () => ({
  createMainLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

import {
  buildPrLinkTools,
  PR_LINK_TOOL,
  PR_LIST_LINKS_TOOL,
  PR_UNLINK_TOOL,
  type PrLinkToolContext,
} from '../../src/main/mcp/pr-link-tools'
import type { McpToolResult } from '../../src/main/mcp/mcp-session'
import { projectReposFrom } from '../../src/shared/project-repos'
import type { PrLink } from '../../src/shared/pull-request-links'
import { prKey, type PrRef, type RepoRef } from '../../src/shared/pull-requests'
import type { RuntimeEvent, RuntimeMode } from '../../src/shared/provider-events'

const APP: RepoRef = { host: 'github', owner: 'acme', name: 'app' }
const FORK: RepoRef = { host: 'github', owner: 'me', name: 'app' }

function setup(mode: RuntimeMode = 'sandbox', opts: { problem?: { at: number; message: string } | null } = {}) {
  const links: PrLink[] = []
  const events: RuntimeEvent[] = []
  const ctx: PrLinkToolContext = {
    threadId: 't1',
    chatId: 'root-1',
    runtimeMode: () => mode,
    publish: (e) => events.push(e),
    pullRequests: {
      chatProject: () => '/p',
      projectRepos: async () => projectReposFrom(APP, [], [FORK]),
      links: () => links,
      linkToChat: vi.fn((_chat: string, ref: PrRef) => {
        if (links.some((l) => prKey(l.ref) === prKey(ref))) return true
        links.push({ ref, source: 'agent', linkedAt: 1 })
        return true
      }),
      unlinkFromChat: vi.fn((_chat: string, ref: PrRef) => {
        const i = links.findIndex((l) => prKey(l.ref) === prKey(ref))
        if (i < 0) return false
        links.splice(i, 1)
        return true
      }),
      linkProblem: () => opts.problem ?? null,
    },
  }
  const tools = Object.fromEntries(buildPrLinkTools(ctx).map((t) => [t.name, t]))
  const call = (name: string, args: Record<string, unknown> = {}) =>
    tools[name].call(args, {} as never) as Promise<McpToolResult>
  return { call, links, events, access: ctx.pullRequests! }
}

const text = (r: McpToolResult) => r.content.map((c) => ('text' in c ? c.text : '')).join('')

describe('link_pull_request', () => {
  it('links a PR of the project by URL, as the agent', async () => {
    const { call, links, access } = setup()
    const r = await call(PR_LINK_TOOL, { pr: 'https://github.com/acme/app/pull/7' })
    expect(r.isError).toBeFalsy()
    expect(links.map((l) => l.ref)).toEqual([{ ...APP, number: 7 }])
    expect(access.linkToChat).toHaveBeenCalledWith('root-1', { ...APP, number: 7 }, false)
    expect(text(r)).toContain('Linked GitHub acme/app #7')
  })

  it('links by repository and number, on another remote of the project', async () => {
    const { call, links } = setup()
    expect((await call(PR_LINK_TOOL, { repository: 'me/app', number: 3 })).isError).toBeFalsy()
    expect(links.map((l) => l.ref)).toEqual([{ ...FORK, number: 3 }])
  })

  it('refuses a PR outside the repositories the project covers', async () => {
    const { call, links } = setup()
    const r = await call(PR_LINK_TOOL, { pr: 'https://github.com/other/thing/pull/1' })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('acme/app, me/app')
    expect(links).toEqual([])
  })

  it('refuses arguments it cannot read', async () => {
    const { call } = setup()
    expect((await call(PR_LINK_TOOL, {})).isError).toBe(true)
    expect((await call(PR_LINK_TOOL, { repository: 'acme/app' })).isError).toBe(true)
    expect((await call(PR_LINK_TOOL, { repository: 'acme', number: 2 })).isError).toBe(true)
  })

  it('runs without a card in every mode but plan, which refuses it with a denial pill', async () => {
    for (const mode of ['sandbox', 'accept-edits', 'auto', 'full-access'] as RuntimeMode[]) {
      expect((await setup(mode).call(PR_LINK_TOOL, { repository: 'acme/app', number: 1 })).isError).toBeFalsy()
    }
    const { call, links, events } = setup('plan')
    const r = await call(PR_LINK_TOOL, { pr: 'https://github.com/acme/app/pull/7' })
    expect(r.isError).toBe(true)
    expect(links).toEqual([])
    expect(events).toMatchObject([{ type: 'tool.denied', toolName: `mcp__switchboard__${PR_LINK_TOOL}`, mode: 'plan' }])
  })
})

describe('unlink_pull_request', () => {
  it('unlinks a linked PR by number', async () => {
    const { call, links, access } = setup()
    await call(PR_LINK_TOOL, { pr: 'https://github.com/acme/app/pull/7' })
    const r = await call(PR_UNLINK_TOOL, { pr: 7 })
    expect(r.isError).toBeFalsy()
    expect(links).toEqual([])
    expect(access.unlinkFromChat).toHaveBeenCalledWith('root-1', { ...APP, number: 7 })
  })

  it('refuses a PR that is not linked, and plan mode', async () => {
    const { call } = setup()
    expect((await call(PR_UNLINK_TOOL, { pr: 7 })).isError).toBe(true)
    const plan = setup('plan')
    plan.links.push({ ref: { ...APP, number: 7 }, source: 'auto', linkedAt: 1 })
    expect((await plan.call(PR_UNLINK_TOOL, { pr: 7 })).isError).toBe(true)
    expect(plan.links).toHaveLength(1)
  })
})

describe('list_thread_pull_requests', () => {
  it('lists links with provenance and state, in plan mode too', async () => {
    const { call, links } = setup('plan')
    links.push({ ref: { ...APP, number: 7 }, source: 'created', linkedAt: 1, state: 'merged', stateAt: 2 })
    const r = await call(PR_LIST_LINKS_TOOL)
    expect(r.isError).toBeFalsy()
    expect(JSON.parse(text(r))).toEqual({
      pullRequests: [
        { pr: 'GitHub acme/app #7', url: 'https://github.com/acme/app/pull/7', linkedBy: 'created', state: 'merged' },
      ],
    })
  })

  it('says when nothing is linked, and shows the last automatic linking problem', async () => {
    const { call } = setup('sandbox', { problem: { at: Date.UTC(2026, 9, 6, 12), message: 'GitHub is unreachable.' } })
    expect(JSON.parse(text(await call(PR_LIST_LINKS_TOOL)))).toEqual({
      pullRequests: [],
      lastAutoLinkProblem: { at: '2026-10-06T12:00:00.000Z', message: 'GitHub is unreachable.' },
    })
  })
})
