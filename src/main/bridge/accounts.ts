/**
 * The accounts the bridge may start a chat on, with how much room each has
 * left. `list_agents` reports them and `start_chat` picks one with
 * `pickBridgeAccount` when the assistant names none.
 *
 * Only what the account picker already shows reaches an answer: the row id,
 * the name the owner gave it, and the two usage windows as percent and reset
 * time. No credential, no config directory, no email the row does not hold.
 * The readings come from the registry's own usage probes and their 45 second
 * cache (`provider/usage`). They are `background`: they answer from the cache
 * where they can, and on a miss they run the same unforced read the Settings
 * Usage button runs, but never read past what the keychain cache kept and
 * never spawn the CLI to refresh a stale token. Naming an account by id costs
 * no read at all.
 */
import { pickBridgeAccount, type BridgeAccountView, type BridgeUsageWindow } from '@shared/bridge'
import type { ProviderUsage, UsageWindow } from '@shared/provider-usage'
import type { AgentType } from '@shared/types'
import { listProviderInstances } from '../db/provider-instances'
import { createMainLogger } from '../logger'

const log = createMainLogger('bridge:accounts')

export interface BridgeAccountDeps {
  /** Enabled accounts of one agent, oldest first, as the picker lists them. */
  accounts(agent: AgentType): Array<{ id: string; name: string }>
  /** That account's usage, unforced. A throw is reported as unreadable. */
  usage(accountId: string): Promise<ProviderUsage>
}

function defaultAccounts(agent: AgentType): Array<{ id: string; name: string }> {
  return listProviderInstances()
    .filter((instance) => instance.enabled && instance.agentType === agent)
    .map((instance) => ({ id: instance.id, name: instance.displayName }))
}

async function defaultUsage(accountId: string): Promise<ProviderUsage> {
  const { fetchInstanceUsage } = await import('../provider/usage')
  return fetchInstanceUsage(accountId, { background: true })
}

const liveAccounts: BridgeAccountDeps = { accounts: defaultAccounts, usage: defaultUsage }

const EMPTY_WINDOW: BridgeUsageWindow = { used_percent: null, resets_at: null }

/**
 * The fullest reading over these window kinds, since a provider can name
 * several and the fullest is what stops the next turn. The weekly signal
 * covers `model` too: Claude reports a per-model weekly limit as its own
 * window, and an account at 100 percent there has no room for that model
 * however empty its general weekly window is.
 */
function windowOf(usage: ProviderUsage, kinds: ReadonlyArray<UsageWindow['kind']>): BridgeUsageWindow {
  const windows = usage.windows.filter((w) => kinds.includes(w.kind))
  if (windows.length === 0) return EMPTY_WINDOW
  const percents = windows.map((w) => w.usedPercent).filter((p): p is number => p !== null)
  const resets = windows.map((w) => w.resetsAtMs).filter((ms): ms is number => ms !== null)
  return {
    used_percent: percents.length > 0 ? Math.max(...percents) : null,
    resets_at: resets.length > 0 ? new Date(Math.min(...resets)).toISOString() : null,
  }
}

function viewOf(account: { id: string; name: string }, usage: ProviderUsage | null): BridgeAccountView {
  if (usage === null || usage.status === 'error' || usage.status === 'unsupported')
    return {
      account_id: account.id,
      name: account.name,
      usage: 'unreadable',
      session: EMPTY_WINDOW,
      weekly: EMPTY_WINDOW,
    }
  if (usage.status === 'not-applicable')
    return {
      account_id: account.id,
      name: account.name,
      usage: 'not_applicable',
      session: EMPTY_WINDOW,
      weekly: EMPTY_WINDOW,
    }
  const session = windowOf(usage, ['session'])
  const weekly = windowOf(usage, ['weekly', 'model'])
  const read = session.used_percent !== null || weekly.used_percent !== null
  return {
    account_id: account.id,
    name: account.name,
    usage: read ? 'ok' : 'unreadable',
    session,
    weekly,
  }
}

/**
 * Every enabled account of one agent with its two windows. The accounts are
 * read in parallel; one that throws is reported `unreadable` rather than
 * dropping the rest, so the owner still sees the account exists.
 */
export async function readBridgeAccounts(
  agent: AgentType,
  deps: BridgeAccountDeps = liveAccounts,
): Promise<BridgeAccountView[]> {
  const accounts = deps.accounts(agent)
  return Promise.all(
    accounts.map(async (account) => {
      try {
        return viewOf(account, await deps.usage(account.id))
      } catch (err) {
        // The detail stays in the log: a usage error message can name a path.
        log.warn('reading an account usage for the bridge failed', { agent, err: String(err) })
        return viewOf(account, null)
      }
    }),
  )
}

/** One account of one agent by its row id, with no usage read at all. */
export function bridgeAccountById(
  agent: AgentType,
  accountId: string,
  deps: BridgeAccountDeps = liveAccounts,
): { account_id: string; name: string } | null {
  const found = deps.accounts(agent).find((a) => a.id === accountId)
  return found ? { account_id: found.id, name: found.name } : null
}

/** Which of these accounts `start_chat` takes when it is given none. */
export function chooseBridgeAccount(accounts: readonly BridgeAccountView[]): string | null {
  return pickBridgeAccount(
    accounts.map((a) => ({
      account_id: a.account_id,
      session_percent: a.session.used_percent,
      weekly_percent: a.weekly.used_percent,
    })),
  )
}
