/**
 * Which buttons a pull request write card shows, which one is primary, and
 * what each sends back. Pure, so the rules are tested without React.
 */
import { checkReplyText, type HostWriteCard, type HostWriteResponse } from '@shared/agent-host-writes'
import { PR_HOST_LABEL } from '@shared/pull-requests'

export interface HostWriteButton {
  id: 'deny' | 'post' | 'post-resolve' | 'resolve' | 'rerun'
  label: string
  primary: boolean
  decision: 'approve' | 'deny'
}

export function hostWriteButtons(card: HostWriteCard): HostWriteButton[] {
  const deny: HostWriteButton = { id: 'deny', label: 'Deny', primary: false, decision: 'deny' }
  if (card.action === 'resolve') return [deny, { id: 'resolve', label: 'Resolve', primary: true, decision: 'approve' }]
  if (card.action === 'rerun') return [deny, { id: 'rerun', label: 'Re-run', primary: true, decision: 'approve' }]
  const resolveFirst = card.suggestResolve === true
  return [
    deny,
    { id: 'post', label: 'Post only', primary: !resolveFirst, decision: 'approve' },
    { id: 'post-resolve', label: 'Post and resolve', primary: resolveFirst, decision: 'approve' },
  ]
}

/** What an approval sends back. `text` is the card's textarea as the user left it. */
export function hostWriteResponse(card: HostWriteCard, button: HostWriteButton['id'], text: string): HostWriteResponse {
  if (card.action !== 'reply') return {}
  return { text, resolve: button === 'post-resolve' }
}

/** Null when the reply may be posted, else why not. The same rule the backend applies. */
export function replyTextProblem(card: HostWriteCard, text: string): string | null {
  if (card.action !== 'reply') return null
  const check = checkReplyText(text)
  return check.ok ? null : check.message
}

/** "Bitbucket · ssg-bot-v2 #612 · sync/worker.py:88". */
export function hostWriteContext(card: HostWriteCard): string {
  return [PR_HOST_LABEL[card.host], card.prLabel, card.location].filter(Boolean).join(' · ')
}
