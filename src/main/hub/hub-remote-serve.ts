/**
 * The child machine's side of `hub-remote:view`, `read-child`, `deliver`,
 * `interrupt`, `stop`, `move` and `stop-all` (capability
 * `hub_remote_control_v1`), registered next to `hub-remote:describe`.
 *
 * Each call names the desktop's install id and a child (or a parent stub).
 * The child must be a row here whose parent is a stub with that `remote_hub`:
 * a child of another hub, or a local child, is refused (`not_own`), and an id
 * with no row here is `not_found` (a stop of it is done). Every field is
 * checked (`shared/hub-remote-control.ts`). They answer with
 * `hub_remote_children` off too, so running work can be read and stopped.
 *
 * The work itself is the registry's (`HubRemoteServeDeps`): the same stop,
 * interrupt, settle, read, move and peer delivery a local parent gets, so the
 * rules stay in one place. `HubRemoteChangeNotifier` sends
 * `hub-remote:children-changed` with the stub ids that changed, at most every
 * 500 ms; `WsHost` sends it only to sessions holding `hub` or `admin`.
 */
import { HubRemoteChannels } from '@shared/ipc-channels'
import {
  HUB_REMOTE_CHANGED_COALESCE_MS,
  HUB_REMOTE_NOT_OWN_TEXT,
  HUB_REMOTE_VIEW_MAX_CHILDREN,
  hubRemoteRefusal,
  parseHubRemoteChildRequest,
  parseHubRemoteDeliverRequest,
  parseHubRemoteMoveRequest,
  parseHubRemoteReadRequest,
  parseHubRemoteStopRequest,
  parseHubRemoteViewRequest,
  type HubRemoteActAnswer,
  type HubRemoteChildState,
  type HubRemoteInterruptAnswer,
  type HubRemoteStopAllAnswer,
  type HubRemoteStopAnswer,
  type HubRemoteToolAnswer,
  type HubRemoteViewAnswer,
} from '@shared/hub-remote-control'
import { isOpenChildPhase, type HubSettleRowView } from '@shared/hub'
import type { RuntimeMode } from '@shared/provider-events'
import type { TurnDelivery } from '@shared/turn-delivery'
import type { BackendHost } from '../backend/host'
import { getHubChild, getHubParent, listHubChildren, type HubChildRow } from '../db/database'
import type { McpToolResult } from '../mcp/mcp-session'
import { createMainLogger } from '../logger'

const log = createMainLogger('hub:remote-serve')

export interface HubRemoteServeDeps {
  childState(row: HubChildRow): Promise<HubRemoteChildState>
  /** `read_child` as the stub parent would call it. */
  read(stubId: string, args: Record<string, unknown>): Promise<McpToolResult>
  /** The parent's message, through `peerDelivery`; throws the refusal. */
  deliver(child: HubChildRow, text: string, delivery: TurnDelivery, fromLabel: string): Promise<void>
  /** `interrupt_child`: true when a turn ran. */
  interrupt(childId: string): Promise<boolean>
  /** The Stop: the child's turn, cards, queue and resume, then its session. True when a turn ran. */
  stop(childId: string): Promise<boolean>
  /** The local settle of one child against the parent's HEAD. */
  settle(
    stubId: string,
    childId: string,
    parentHead: string | null,
  ): Promise<{ ok: true; row: HubSettleRowView | null } | { ok: false; text: string }>
  move(stubId: string, parentMode: RuntimeMode, childId: string, instanceId: string): Promise<McpToolResult>
}

type Owned = { ok: true; child: HubChildRow } | { ok: false; answer: Extract<HubRemoteActAnswer, { ok: false }> }

/** The child, when it is here under a stub of that desktop. */
function ownedChild(installId: string, childId: string): Owned {
  const child = getHubChild(childId)
  if (!child) return { ok: false, answer: hubRemoteRefusal('not_found', `No child ${childId} is on this machine.`) }
  const parent = getHubParent(child.parentId)
  if (!parent?.remoteHub || parent.remoteHub !== installId)
    return { ok: false, answer: hubRemoteRefusal('not_own', HUB_REMOTE_NOT_OWN_TEXT) }
  return { ok: true, child }
}

/** Null: the stub is that desktop's, or there is none yet. Else the refusal. */
function stubRefusal(installId: string, parentId: string): Extract<HubRemoteActAnswer, { ok: false }> | null {
  const parent = getHubParent(parentId)
  if (!parent) return null
  return parent.remoteHub === installId ? null : hubRemoteRefusal('not_own', HUB_REMOTE_NOT_OWN_TEXT)
}

const toolAnswer = (r: McpToolResult): HubRemoteToolAnswer => ({
  v: 1,
  ok: true,
  text: r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n'),
  isError: r.isError === true,
})

const failed = (err: unknown) => hubRemoteRefusal('failed', err instanceof Error ? err.message : String(err))

export function registerHubRemoteControlHandlers(host: BackendHost, deps: HubRemoteServeDeps): void {
  host.handle(HubRemoteChannels.VIEW, async (raw: unknown): Promise<HubRemoteViewAnswer | HubRemoteActAnswer> => {
    const parsed = parseHubRemoteViewRequest(raw)
    if (!parsed.ok) return hubRemoteRefusal('invalid', parsed.message)
    const { desktopInstallId, parentId } = parsed.request
    const refusal = stubRefusal(desktopInstallId, parentId)
    if (refusal) return refusal
    const rows = getHubParent(parentId)
      ? listHubChildren(parentId, { includeSettled: true }).slice(-HUB_REMOTE_VIEW_MAX_CHILDREN)
      : []
    return { v: 1, children: await Promise.all(rows.map((c) => deps.childState(c))) }
  })

  host.handle(HubRemoteChannels.READ_CHILD, async (raw: unknown): Promise<HubRemoteToolAnswer> => {
    const parsed = parseHubRemoteReadRequest(raw)
    if (!parsed.ok) return hubRemoteRefusal('invalid', parsed.message)
    const owned = ownedChild(parsed.request.desktopInstallId, parsed.request.childId)
    if (!owned.ok) return owned.answer
    try {
      return toolAnswer(await deps.read(owned.child.parentId, { ...parsed.request.args, childId: owned.child.childId }))
    } catch (err) {
      log.warn(`could not read child ${owned.child.childId} for its hub`, err)
      return failed(err)
    }
  })

  host.handle(HubRemoteChannels.DELIVER, async (raw: unknown): Promise<HubRemoteActAnswer> => {
    const parsed = parseHubRemoteDeliverRequest(raw)
    if (!parsed.ok) return hubRemoteRefusal('invalid', parsed.message)
    const { desktopInstallId, childId, text, delivery, fromLabel } = parsed.request
    const owned = ownedChild(desktopInstallId, childId)
    if (!owned.ok) return owned.answer
    if (!isOpenChildPhase(owned.child.phase))
      return hubRemoteRefusal('failed', `${owned.child.title} is not open, so it takes no message.`)
    try {
      await deps.deliver(owned.child, text, delivery, fromLabel)
      return { v: 1, ok: true }
    } catch (err) {
      log.info('a message from the hub was refused here', { childId, delivery })
      return failed(err)
    }
  })

  host.handle(HubRemoteChannels.INTERRUPT, async (raw: unknown): Promise<HubRemoteInterruptAnswer> => {
    const parsed = parseHubRemoteChildRequest(raw, 'interrupt request')
    if (!parsed.ok) return hubRemoteRefusal('invalid', parsed.message)
    const owned = ownedChild(parsed.request.desktopInstallId, parsed.request.childId)
    if (!owned.ok) return owned.answer
    if (!isOpenChildPhase(owned.child.phase)) return { v: 1, ok: true, ran: false }
    try {
      return { v: 1, ok: true, ran: await deps.interrupt(owned.child.childId) }
    } catch (err) {
      log.warn(`could not interrupt child ${owned.child.childId} for its hub`, err)
      return failed(err)
    }
  })

  host.handle(HubRemoteChannels.STOP, async (raw: unknown): Promise<HubRemoteStopAnswer> => {
    const parsed = parseHubRemoteStopRequest(raw)
    if (!parsed.ok) return hubRemoteRefusal('invalid', parsed.message)
    const { desktopInstallId, childId, settle } = parsed.request
    const owned = ownedChild(desktopInstallId, childId)
    if (!owned.ok) return owned.answer
    const child = owned.child
    try {
      if (settle) {
        // Settled already: the earlier answer was lost, so it is done.
        if (child.phase === 'settled') return { v: 1, ok: true, ran: false }
        const r = await deps.settle(child.parentId, child.childId, settle.parentHead)
        if (!r.ok) return hubRemoteRefusal('failed', r.text)
        return { v: 1, ok: true, ran: false, ...(r.row ? { settled: r.row } : {}) }
      }
      if (!isOpenChildPhase(child.phase)) return { v: 1, ok: true, ran: false }
      return { v: 1, ok: true, ran: await deps.stop(child.childId) }
    } catch (err) {
      log.warn(`could not stop child ${child.childId} for its hub`, err)
      return failed(err)
    }
  })

  host.handle(HubRemoteChannels.MOVE, async (raw: unknown): Promise<HubRemoteToolAnswer> => {
    const parsed = parseHubRemoteMoveRequest(raw)
    if (!parsed.ok) return hubRemoteRefusal('invalid', parsed.message)
    const { desktopInstallId, childId, instanceId, parentMode } = parsed.request
    const owned = ownedChild(desktopInstallId, childId)
    if (!owned.ok) return owned.answer
    try {
      return toolAnswer(await deps.move(owned.child.parentId, parentMode, owned.child.childId, instanceId))
    } catch (err) {
      log.warn(`could not move child ${owned.child.childId} for its hub`, err)
      return failed(err)
    }
  })

  host.handle(
    HubRemoteChannels.STOP_ALL,
    async (raw: unknown): Promise<HubRemoteStopAllAnswer | HubRemoteActAnswer> => {
      const parsed = parseHubRemoteViewRequest(raw, 'stop-all request')
      if (!parsed.ok) return hubRemoteRefusal('invalid', parsed.message)
      const { desktopInstallId, parentId } = parsed.request
      const refusal = stubRefusal(desktopInstallId, parentId)
      if (refusal) return refusal
      const open = getHubParent(parentId) ? listHubChildren(parentId).filter((c) => isOpenChildPhase(c.phase)) : []
      const results = await Promise.allSettled(open.map((c) => deps.stop(c.childId)))
      const failures = results.filter((r) => r.status === 'rejected')
      for (const r of failures) log.warn('a child did not stop for its hub', (r as PromiseRejectedResult).reason)
      if (failures.length > 0)
        return hubRemoteRefusal('failed', `${failures.length} of ${open.length} children did not stop.`)
      log.info('children stopped for their hub', { parentId, stopped: open.length })
      return { v: 1, ok: true, stopped: open.length }
    },
  )
}

/** `hub-remote:children-changed` with the stub ids that changed, at most every 500 ms. */
export class HubRemoteChangeNotifier {
  private readonly pending = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly emit: (parentIds: string[]) => void,
    private readonly coalesceMs = HUB_REMOTE_CHANGED_COALESCE_MS,
  ) {}

  /** A parent here changed: sent when it is a stub of another machine's hub. */
  changed(parentId: string): void {
    try {
      if (!getHubParent(parentId)?.remoteHub) return
    } catch (err) {
      log.warn(`could not read parent ${parentId} for the change event`, err)
      return
    }
    this.pending.add(parentId)
    this.timer ??= setTimeout(() => this.flush(), this.coalesceMs)
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending.clear()
  }

  private flush(): void {
    this.timer = null
    const ids = [...this.pending]
    this.pending.clear()
    if (ids.length > 0) this.emit(ids)
  }
}
