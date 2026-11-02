/**
 * The phone's Snooze sheet (long press or swipe on a Home > Recents row): the
 * machine's presets resolved when the sheet opens, each with its wake time, and "Until
 * PR #n changes" when the chat links an open PR. No custom time on the phone.
 * The same rules as native Android's `ChatSnooze.kt`.
 */
import {
  DEFAULT_SNOOZE_PRESETS,
  pickPreset,
  presetKindOf,
  resolvePresets,
  wakeLabel,
  type ConversationSnoozedEvent,
  type PresetOption,
  type SnoozeRefusal,
  type SnoozeRequest,
  type SnoozePresetSpec,
  type SnoozeResult,
} from '@shared/chat-snooze'
import type { SnoozePrChoice } from '@shared/chat-snooze-pr'

export type SnoozeChoice = { kind: 'preset'; option: PresetOption } | { kind: 'pr'; pr: SnoozePrChoice }

export interface SnoozeSheetItem {
  key: string
  label: string
  /** The wake time on the right; none for the PR item. */
  detail: string
  choice: SnoozeChoice
}

/** `presets` is the machine's list (`chats.snoozePresets`); the defaults for a backend without it. */
export function snoozeSheetItems(
  now: Date,
  pr: SnoozePrChoice | null,
  presets: readonly SnoozePresetSpec[] = DEFAULT_SNOOZE_PRESETS,
): SnoozeSheetItem[] {
  const items: SnoozeSheetItem[] = resolvePresets(now, presets).map((option) => ({
    key: `${option.label}:${option.at}`,
    label: option.label,
    detail: wakeLabel(option.at, null, now),
    choice: { kind: 'preset', option },
  }))
  if (pr) items.push({ key: 'pr', label: `Until PR #${pr.number} changes`, detail: '', choice: { kind: 'pr', pr } })
  return items
}

/** What a tap sends: a duration counts from the tap, a clock time keeps the instant the sheet showed. */
export function snoozeRequestFor(
  choice: SnoozeChoice,
  now: number,
): { ok: true; request: SnoozeRequest } | { ok: false; reason: SnoozeRefusal } {
  if (choice.kind === 'pr')
    return { ok: true, request: { until: null, pr: choice.pr.key, preset: 'pr', surface: 'phone' } }
  const picked = pickPreset(choice.option, now)
  if (!picked.ok) return picked
  return { ok: true, request: { until: picked.at, preset: presetKindOf(choice.option.spec), surface: 'phone' } }
}

/** The broadcast the backend will send, applied at once from its answer. */
export function snoozedEvent(
  conversationId: string,
  result: Extract<SnoozeResult, { ok: true }>,
  now: number,
): ConversationSnoozedEvent {
  return {
    conversationId,
    snoozedUntil: result.until,
    snoozedAt: now,
    snoozePr: result.pr,
    snoozeRev: result.rev,
    wokeAt: null,
    wokeReason: null,
  }
}

export function wokenEvent(conversationId: string, rev: number | undefined, prior: number): ConversationSnoozedEvent {
  return {
    conversationId,
    snoozedUntil: null,
    snoozedAt: null,
    snoozePr: null,
    snoozeRev: rev ?? prior + 1,
    wokeAt: null,
    wokeReason: null,
  }
}
