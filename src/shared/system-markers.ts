/**
 * How a phone shows one stored system row (`role: 'system'`): a Switchboard
 * marker (`[[sb:<kind>]] ...`) or a persisted error. The desktop renders the
 * same rows with its own components (MessageBubble); this is the one rule both
 * phones follow, ported to Android as `SystemMarkers.kt` with the same vectors.
 */
import { approvalResultLabel, parseApprovalResultMarker } from './agent-approval-cards'
import { mergeBackRowDetails, mergeBackRowTitle, parseMergeBackMarker } from './merge-back'
import { parseUndeliveredMarker, type PeerUndelivered } from './peer-links'
import { CONTEXT_HANDOFF_MARKER_PREFIX, parseRotationMarker, type RotationMarker } from './rotation-marker'

export const SYSTEM_MARKER_PREFIX = '[[sb:'

/** What a marker this build does not know shows, instead of its raw payload. */
export const UNKNOWN_SYSTEM_MARKER_TITLE = 'Switchboard notice'

export type SystemRowView =
  | { kind: 'peer-undelivered'; row: PeerUndelivered }
  | { kind: 'error'; message: string }
  | { kind: 'notice'; title: string; body: string }

/** The desktop's pill text for the `<from> → <to>` markers. */
export function rotationMarkerText(marker: RotationMarker): string {
  switch (marker.kind) {
    case 'agent': return `Switched agent: ${marker.fromName} → ${marker.toName}`
    case 'handoff': return `Context handoff: ${marker.fromName} → ${marker.toName}`
    case 'peer': return `Sent to ${marker.toName}`
    case 'peer-agent': return `The agent messaged ${marker.toName}`
    case 'instance': return `Switched profile: ${marker.fromName} → ${marker.toName}`
  }
}

/** Why a link refused the message, in plain words. */
export function peerUndeliveredReasonText(row: PeerUndelivered): string {
  switch (row.reason) {
    case 'link-expired': return "The link's time ran out."
    case 'link-budget': return "The link's message budget was spent."
    case 'link-removed': return 'The link was removed before it was sent.'
  }
}

export function systemRowView(content: string): SystemRowView {
  const undelivered = parseUndeliveredMarker(content)
  if (undelivered) return { kind: 'peer-undelivered', row: undelivered }
  const approval = parseApprovalResultMarker(content)
  if (approval) return { kind: 'notice', title: approvalResultLabel(approval), body: approval.text }
  // Read-only on a phone: the card's heading and bullets, not the whole summary.
  const mergeBack = parseMergeBackMarker(content)
  if (mergeBack) return { kind: 'notice', title: mergeBackRowTitle(mergeBack), body: mergeBackRowDetails(mergeBack).join('\n') }
  const rotation = parseRotationMarker(content)
  if (rotation) return { kind: 'notice', title: rotationMarkerText(rotation), body: '' }
  // The profile-restart handoff has no `<from> → <to>`, only a sentence.
  if (content.startsWith(CONTEXT_HANDOFF_MARKER_PREFIX)) {
    return { kind: 'notice', title: 'Context handoff', body: content.slice(CONTEXT_HANDOFF_MARKER_PREFIX.length).trim() }
  }
  // A newer marker, or a known one whose payload did not parse: never its JSON.
  if (content.startsWith(SYSTEM_MARKER_PREFIX)) return { kind: 'notice', title: UNKNOWN_SYSTEM_MARKER_TITLE, body: '' }
  if (/^Error:/i.test(content)) return { kind: 'error', message: content }
  return { kind: 'notice', title: UNKNOWN_SYSTEM_MARKER_TITLE, body: content }
}
