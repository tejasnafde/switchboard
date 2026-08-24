import { createHash } from 'node:crypto'
import {
  digestForkMessage,
  isForkableForkMessage,
  type ForkAnchor,
  type ResolvedForkAnchor,
} from '../../shared/conversation-fork'
import type { ChatMessage } from '../../shared/types'

export interface ForkMessageProvenance {
  provider: 'claude-code' | 'codex' | 'opencode'
  providerSessionId?: string | null
  providerEventId?: string | null
}

export interface CanonicalForkMessage {
  message: ChatMessage
  forkable: boolean
  provenance?: ForkMessageProvenance
}

export interface ForkAnchorConflict {
  code: 'missing-anchor' | 'ambiguous-anchor' | 'stale-anchor' | 'non-forkable-anchor'
  message: string
  candidateCount: number
}

/** Product-level eligibility for a real transcript boundary. System status,
 * approval UI and tool-only activity remain visible but cannot author forks. */
export function isForkableCanonicalMessage(message: ChatMessage): boolean {
  return isForkableForkMessage(message)
}

export type ResolveCanonicalForkAnchorResult =
  | {
      ok: true
      prefix: ChatMessage[]
      resolved: ResolvedForkAnchor
    }
  | {
      ok: false
      conflict: ForkAnchorConflict
    }

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function matchesFingerprint(candidate: ChatMessage, anchor: ForkAnchor): boolean {
  return candidate.role === anchor.role
    && candidate.timestamp === anchor.timestamp
    && digestForkMessage(candidate, sha256) === anchor.contentDigest.toLowerCase()
}

function conflict(
  code: ForkAnchorConflict['code'],
  message: string,
  candidateCount: number,
): ResolveCanonicalForkAnchorResult {
  return { ok: false, conflict: { code, message, candidateCount } }
}

export function resolveCanonicalForkAnchor(
  history: CanonicalForkMessage[],
  anchor: ForkAnchor,
): ResolveCanonicalForkAnchorResult {
  const exact = history.filter((candidate) => candidate.message.id === anchor.messageId)
  let selected: CanonicalForkMessage
  let resolution: ResolvedForkAnchor['resolution']

  if (exact.length > 1) {
    return conflict(
      'ambiguous-anchor',
      'The fork anchor matches more than one canonical message.',
      exact.length,
    )
  }
  if (exact.length === 1) {
    selected = exact[0]
    if (!selected.forkable) {
      return conflict(
        'non-forkable-anchor',
        'The selected item is not a durable conversation boundary.',
        1,
      )
    }
    if (!matchesFingerprint(selected.message, anchor)) {
      return conflict(
        'stale-anchor',
        'The selected message changed after the fork action was prepared.',
        1,
      )
    }
    resolution = 'exact-id'
  } else {
    const legacy = history.filter((candidate) =>
      candidate.forkable && matchesFingerprint(candidate.message, anchor))
    if (legacy.length === 0) {
      return conflict(
        'missing-anchor',
        'The fork anchor no longer exists in canonical history.',
        0,
      )
    }
    if (legacy.length > 1) {
      return conflict(
        'ambiguous-anchor',
        'The fork anchor matches more than one canonical message.',
        legacy.length,
      )
    }
    selected = legacy[0]
    resolution = 'unique-legacy-fingerprint'
  }

  const canonical = history.filter((candidate) => candidate.forkable)
  const canonicalIndex = canonical.indexOf(selected)
  if (canonicalIndex < 0) {
    return conflict(
      'non-forkable-anchor',
      'The selected item is not a durable conversation boundary.',
      1,
    )
  }
  const provenance = selected.provenance
  return {
    ok: true,
    prefix: canonical.slice(0, canonicalIndex + 1).map((candidate) => candidate.message),
    resolved: {
      messageId: selected.message.id,
      role: selected.message.role,
      timestamp: selected.message.timestamp,
      contentDigest: digestForkMessage(selected.message, sha256),
      canonicalIndex,
      canonicalMessageCount: canonical.length,
      resolution,
      provider: provenance?.provider ?? null,
      providerSessionId: provenance?.providerSessionId ?? null,
      providerEventId: provenance?.providerEventId ?? null,
      preview: selected.message.content.trim().replace(/\s+/g, ' ').slice(0, 140)
        || (selected.message.images?.length ? 'Image attachment' : 'Conversation message'),
    },
  }
}
