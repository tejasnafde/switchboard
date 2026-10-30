/**
 * The `secret_request.*` usage counts (design section 11). Each takes only
 * closed-list buckets, so no caller can pass a secret's name, title,
 * instructions, value or length; `shared/analytics-envelope.ts` drops
 * anything else. They are sent only while the `agent_secret_request` flag
 * is on: with it off, an archive or the sweep can still close a card or
 * delete a file saved earlier, and that is not counted.
 */
import type { ProviderKind } from '@shared/provider-events'
import {
  agentSecretRequestEnabled,
  secretAnswerSecondsBucket,
  secretExtendCountBucket,
  type SecretTtl,
} from '@shared/agent-secret-request'
import type { AnalyticsEventName } from '@shared/analytics-envelope'
import type { SecretMaskWhere } from './runtime-event-redaction'
import { trackAnalyticsEvent } from '../analytics'
import { getSetting } from '../db/database'
import { createMainLogger } from '../logger'

const log = createMainLogger('secrets:analytics')

function track(event: AnalyticsEventName, properties: Record<string, string>): void {
  try {
    if (!agentSecretRequestEnabled(process.env, getSetting)) return
  } catch (err) {
    log.debug('could not read the agent_secret_request flag; not counted', { event, err: String(err) })
    return
  }
  trackAnalyticsEvent(event, properties)
}

export type SecretRefusalReason = 'plan' | 'child' | 'cap' | 'invalid'
export type SecretCloseOutcome = 'expired' | 'withdrawn' | 'archived' | 'deleted'

export function trackSecretOpened(agentKind: ProviderKind, ttl: SecretTtl, remote: boolean): void {
  track('secret_request.opened', { agentKind, ttlBucket: ttl, remote: remote ? 'true' : 'false' })
}

/** `count` is how many times this secret has been extended, this one included. */
export function trackSecretExtended(count: number): void {
  track('secret_request.extended', { count: secretExtendCountBucket(count) })
}

export function trackSecretAnswered(outcome: 'saved' | 'declined', answeredAfterMs: number): void {
  track('secret_request.answered', {
    outcome,
    secondsBucket: secretAnswerSecondsBucket(answeredAfterMs),
  })
}

export function trackSecretClosed(outcome: SecretCloseOutcome): void {
  track('secret_request.closed', { outcome })
}

export function trackSecretRefused(reason: SecretRefusalReason): void {
  track('secret_request.refused', { reason })
}

export function trackSecretMasked(where: SecretMaskWhere): void {
  track('secret_request.masked', { where })
}
