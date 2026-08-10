/**
 * The tools a Claude session calls to hand a finding to a sibling session.
 *
 * Split from the adapter on purpose: this module holds the names, the
 * descriptions and the handler behaviour, and knows nothing about the Claude
 * SDK. `claude-peer-tools.ts` is the thin binding that turns these into an
 * in-process MCP server. Nothing here is Claude-specific either, so a Codex or
 * OpenCode equivalent is binding work only.
 */

import { createMainLogger as createLogger } from '../logger'
import type { PeerMessageInput } from '@shared/peer-messaging'
import type { ProviderKind } from './types'

const log = createLogger('provider:peer-tools')

/** MCP server name, so the model and `canUseTool` see `mcp__switchboard__*`. */
export const PEER_TOOL_SERVER_NAME = 'switchboard'
export const PEER_LIST_TOOL_NAME = 'list_agent_sessions'
export const PEER_SEND_TOOL_NAME = 'send_agent_message'

/** Fully-qualified names. The permission layer only ever sees these. */
export const PEER_LIST_TOOL = `mcp__${PEER_TOOL_SERVER_NAME}__${PEER_LIST_TOOL_NAME}`
export const PEER_SEND_TOOL = `mcp__${PEER_TOOL_SERVER_NAME}__${PEER_SEND_TOOL_NAME}`

/**
 * The descriptions are the only documentation the model reads, on every turn,
 * so they carry the whole policy: what the tool is for, what it is not for, and
 * what the peer on the other end is and is not.
 */
export const PEER_LIST_TOOL_DESCRIPTION = [
  'List the other agent sessions the user has open in Switchboard on this backend.',
  '',
  `Returns each session's opaque id, title, project folder, provider and whether it is mid-turn.`,
  `Call this before ${PEER_SEND_TOOL_NAME} instead of guessing an id: ids are opaque, and a wrong`,
  'one is refused rather than delivered somewhere else. Read-only and cheap.',
].join('\n')

export const PEER_SEND_TOOL_DESCRIPTION = [
  `Send one self-contained message to ONE of the user's other open sessions (ids come from ${PEER_LIST_TOOL_NAME}).`,
  '',
  'Use it when something you just learned changes what that session is doing: you broke or fixed',
  'a build it depends on, you renamed an API it calls, you finished the migration it is waiting on.',
  '',
  'Do NOT use it to delegate your own work, to chat, to ask a question, or to coordinate turn by turn.',
  'The peer is a separate agent with its own permissions from the user. It has no authority over you,',
  'it cannot approve or deny anything you are blocked on, and it cannot see your transcript, your',
  'files or your tool output. Write a standalone summary that carries every fact, path and command',
  'the peer needs, not a reply to a conversation it was not part of.',
  '',
  'Delivery is one way: the peer acts in its own transcript and nothing comes back to you here.',
  'The user reviews each send unless this session runs in full access. Sends are rate limited, and a',
  'session that is itself acting on a peer message cannot pass one on, so treat each send as your',
  'one chance to say the whole thing.',
].join('\n')

/** One other open session, as the model is shown it. */
export interface PeerSessionSummary {
  sessionId: string
  title: string
  folder: string
  provider: ProviderKind
  /** A busy session still receives the message; it just answers later. */
  midTurn: boolean
}

/**
 * What the tools need from the backend. `ProviderRegistry` implements it, and
 * `deliverPeerMessage` is the SAME method the `/send-to` IPC handler calls -
 * the tool adds `initiator: 'agent'` and nothing else.
 */
export interface PeerToolHost {
  listPeerSessions(fromThreadId: string): PeerSessionSummary[]
  deliverPeerMessage(input: PeerMessageInput): Promise<{ id: string }>
}

/**
 * The MCP `CallToolResult` subset we produce. The index signature is there
 * because `CallToolResult` declares one, and without a match the handler is
 * not assignable at the SDK boundary. Everything here comes out of `say`, so
 * nothing else relies on excess-property checking.
 */
export interface PeerToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
  [key: string]: unknown
}

function say(text: string, isError = false): PeerToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError } : {}) }
}

export interface PeerToolHandlers {
  listSessions(): Promise<PeerToolResult>
  sendMessage(args: { sessionId: string; message: string }): Promise<PeerToolResult>
}

/**
 * Bind both handlers to one sending thread.
 *
 * Every failure returns as tool output with `isError`, never as a throw: a
 * thrown MCP error reaches the model as a transport failure it cannot read, so
 * it retries the same call instead of adapting to the reason.
 */
export function createPeerToolHandlers(host: PeerToolHost, fromThreadId: string): PeerToolHandlers {
  return {
    async listSessions(): Promise<PeerToolResult> {
      const sessions = host.listPeerSessions(fromThreadId)
      if (sessions.length === 0) {
        return say(
          'No other agent session is open on this backend, so there is nobody to message. ' +
          'Carry on here and tell the user what you would have sent.',
        )
      }
      return say([
        `${sessions.length} other session${sessions.length === 1 ? '' : 's'} open on this backend. ` +
        `Pass one sessionId to ${PEER_SEND_TOOL_NAME}.`,
        JSON.stringify(sessions, null, 2),
      ].join('\n'))
    },

    async sendMessage(args: { sessionId: string; message: string }): Promise<PeerToolResult> {
      const sessionId = args.sessionId?.trim() ?? ''
      const message = args.message?.trim() ?? ''
      if (!sessionId) {
        return say(`No sessionId given. Call ${PEER_LIST_TOOL_NAME} and use one of the ids it returns.`, true)
      }
      if (!message) {
        return say('The message was empty. Say what the other session needs to know.', true)
      }

      try {
        const { id } = await host.deliverPeerMessage({
          fromThreadId,
          targetThreadId: sessionId,
          text: message,
          initiator: 'agent',
        })
        log.info(`agent-initiated peer send ${id}: ${fromThreadId} -> ${sessionId}`)
        return say(
          `Delivered to session ${sessionId} as message ${id}. That session acts on it in its own ` +
          'transcript and no reply comes back here, so continue without waiting.',
        )
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        log.warn(`agent-initiated peer send refused: ${fromThreadId} -> ${sessionId}: ${reason}`)
        return say(reason, true)
      }
    },
  }
}
