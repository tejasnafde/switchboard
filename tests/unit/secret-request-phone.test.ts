/**
 * The pure rules the phones use for a secret card: the result row as one
 * line, the instructions with the URL host split out without a URL parser,
 * the plain detail an older client shows, and the push text.
 */
import { describe, expect, it } from 'vitest'
import { SECRET_REQUEST_DETAIL, secretInstructionParts, secretResultLine } from '../../src/shared/agent-secret-request'
import type { ApprovalResultRow } from '../../src/shared/agent-approval-cards'
import { pushForEvent } from '../../src/shared/push-policy'

const row = (patch: Partial<ApprovalResultRow>): ApprovalResultRow => ({
  requestId: 'sbsec_1',
  title: 'Secret TAILSCALE_AUTHKEY',
  outcome: 'done',
  text: 'Saved TAILSCALE_AUTHKEY.',
  delivery: 'turn',
  ...patch,
})

describe('secret result line on a phone', () => {
  it('reads Saved, Declined and expired, with no time left', () => {
    expect(secretResultLine(row({}))).toEqual({
      kind: 'saved',
      name: 'TAILSCALE_AUTHKEY',
      text: 'Saved TAILSCALE_AUTHKEY',
    })
    expect(secretResultLine(row({ outcome: 'declined' }))?.text).toBe('Declined TAILSCALE_AUTHKEY')
    expect(secretResultLine(row({ outcome: 'dismissed' }))?.text).toBe('Declined TAILSCALE_AUTHKEY')
    expect(secretResultLine(row({ outcome: 'expired' }))?.text).toBe('TAILSCALE_AUTHKEY expired')
    expect(secretResultLine(row({ outcome: 'stopped' }))?.kind).toBe('expired')
  })

  it('is null for any other card', () => {
    expect(secretResultLine(row({ requestId: 'sbmcp_1' }))).toBeNull()
  })
})

describe('secret instructions on a phone', () => {
  it('splits the host out and drops the scheme', () => {
    expect(
      secretInstructionParts('Create it at https://login.tailscale.com/admin/settings/keys, then Generate auth key.'),
    ).toEqual([
      { kind: 'text', text: 'Create it at ' },
      { kind: 'host', host: 'login.tailscale.com', rest: '/admin/settings/keys' },
      { kind: 'text', text: ', then Generate auth key.' },
    ])
  })

  it('shows the real host, never a user part', () => {
    const [, url] = secretInstructionParts('see https://dashboard.example.com@evil.example/keys.')
    expect(url).toEqual({ kind: 'host', host: 'evil.example', rest: '/keys' })
  })

  it('keeps a bare host, a port, and plain text', () => {
    expect(secretInstructionParts('http://Example.test')).toEqual([{ kind: 'host', host: 'example.test', rest: '' }])
    expect(secretInstructionParts('http://localhost:8080?x=1')).toEqual([
      { kind: 'host', host: 'localhost:8080', rest: '?x=1' },
    ])
    expect(secretInstructionParts('no links here')).toEqual([{ kind: 'text', text: 'no links here' }])
  })

  it('leaves a URL with an odd host as text', () => {
    expect(secretInstructionParts('go to http://bad_host.test/x')).toEqual([
      { kind: 'text', text: 'go to http://bad_host.test/x' },
    ])
    expect(secretInstructionParts('go to http:///x')).toEqual([{ kind: 'text', text: 'go to http:///x' }])
  })
})

describe('secret request for older clients and push', () => {
  const opened = {
    type: 'request.opened' as const,
    threadId: 'chat',
    requestId: 'sbsec_1',
    requestType: 'tool' as const,
    toolName: 'mcp__switchboard__request_secret',
    detail: `${SECRET_REQUEST_DETAIL}\n\nThis card stays open.`,
    secretRequest: {
      name: 'TAILSCALE_AUTHKEY',
      title: 'Tailscale auth key',
      instructions: 'Open https://login.tailscale.com/admin',
      ttl: '24h' as const,
    },
  }

  it('keeps the plain detail an older client shows', () => {
    expect(SECRET_REQUEST_DETAIL).toBe('An agent asks for a secret. Answer it in Switchboard on your computer.')
  })

  it('pushes the chat name and a fixed line, never the title or instructions', () => {
    const push = pushForEvent(opened, { title: 'Deploy chat' })
    expect(push).toMatchObject({ title: 'Deploy chat', body: 'An agent asks for a secret' })
    expect(JSON.stringify(push)).not.toMatch(/Tailscale|tailscale|TAILSCALE/)
  })
})
