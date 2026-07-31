import type { OverageScope } from './claude-rate-limit'

/**
 * Remembered extra-usage rejections, so the composer can warn before a send
 * that is certain to fail.
 *
 * Keyed per (instanceId, model), NOT per instance: other models on the same
 * seat keep working, so a per-instance block would push users back into the
 * pointless profile rotation this exists to prevent.
 * See docs/notes/rate-limit-debugging.md.
 */

/** Models covered by the plan on every seat checked. */
export const PLAN_COVERED_HINT = ['opus', 'sonnet', 'haiku'] as const

export interface SpendBlock {
  /** null when the session ran on the default instance and none was recorded. */
  instanceId: string | null
  model: string
  reason: string | null
  /**
   * Scope of the block. Carried so this warning cannot contradict the chat
   * error: an org-wide cap makes profile rotation useless, but an
   * account-scoped one does not, and saying otherwise repeats the bug this
   * whole change fixes. Optional for blocks persisted before it existed.
   */
  scope?: OverageScope
  /** Epoch ms the credit pool resets. null when unknown. */
  resetsAtMs: number | null
  recordedAtMs: number
}

/** Bounded: an admin can lift the cap at any time, so a warning must expire. */
export const UNKNOWN_RESET_TTL_MS = 6 * 60 * 60 * 1000

export function isSpendBlockActive(block: SpendBlock, nowMs: number): boolean {
  if (block.resetsAtMs !== null) return nowMs < block.resetsAtMs
  return nowMs - block.recordedAtMs < UNKNOWN_RESET_TTL_MS
}

/** Same instance AND same model. A different model on the same seat is fine. */
function isSamePair(a: SpendBlock, instanceId: string | null, model: string): boolean {
  return a.instanceId === instanceId && a.model === model
}

export function findSpendBlock(
  blocks: SpendBlock[],
  instanceId: string | null,
  model: string | null,
  nowMs: number,
): SpendBlock | null {
  if (!model) return null
  const hit = blocks.find((b) => isSamePair(b, instanceId, model))
  if (!hit) return null
  return isSpendBlockActive(hit, nowMs) ? hit : null
}

/** Replaces the entry for this pair, and drops expired ones while it is here. */
export function upsertSpendBlock(
  blocks: SpendBlock[],
  next: SpendBlock,
  nowMs: number,
): SpendBlock[] {
  const kept = blocks.filter(
    (b) => !isSamePair(b, next.instanceId, next.model) && isSpendBlockActive(b, nowMs),
  )
  return [...kept, next]
}

export function pruneSpendBlocks(blocks: SpendBlock[], nowMs: number): SpendBlock[] {
  return blocks.filter((b) => isSpendBlockActive(b, nowMs))
}

/** Composer warning. Names the model, which the picker can render as "Default". */
export function describeSpendBlock(block: SpendBlock): string {
  const reason = block.reason ? ` (${block.reason})` : ''
  const head = `${block.model} billed to extra usage here and was refused${reason}. `
    + `Pick ${PLAN_COVERED_HINT.join(', ')} or another model your plan covers`
  // Only an org-wide cap makes profile rotation pointless. Saying it for an
  // account-scoped block would contradict the chat error, which correctly
  // offers another instance in that case.
  if (block.scope === 'account') return `${head}, or switch to another profile.`
  if (block.scope === 'not-provisioned') return `${head}, or ask an org admin to enable extra usage.`
  return `${head}, or ask an org admin to raise the spend limit. `
    + `Switching profile inside the same organisation will not help.`
}
