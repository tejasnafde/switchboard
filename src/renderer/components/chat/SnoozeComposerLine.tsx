/**
 * The line above the composer of a snoozed chat open in the primary slot:
 * "Snoozed until 20:00" and Wake now, in the style of the Limited row. The
 * chat stays open while it is snoozed; its row sits in the sidebar's Snoozed
 * group.
 */
import { snoozeLineText } from '@shared/chat-snooze'
import { useSnoozeStore } from '../../stores/snooze-store'
import { wakeChat } from '../../services/chat-inbox'
import { Button } from '../ui/button'
import { ClockIcon } from './chat-icons'

export function SnoozeComposerLine({
  sessionId,
  title,
  machineId,
}: {
  sessionId: string
  title: string
  machineId: string
}) {
  const snooze = useSnoozeStore((s) => s.byId[sessionId])
  if (snooze?.snoozedAt == null) return null
  return (
    <div
      data-snooze-line
      className="mx-6 mb-2 flex items-center gap-[10px] rounded-[10px] border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-[12px] text-[var(--text-secondary)]"
    >
      <ClockIcon size={14} />
      <div className="min-w-0 flex-1 text-[13px] font-[600] text-[var(--text-primary)] [font-variant-numeric:tabular-nums]">
        {snoozeLineText(snooze.snoozedUntil ?? null, snooze.snoozePr ?? null, new Date())}
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={() => void wakeChat({ id: sessionId, title, machineId }, 'composer')}
      >
        Wake now
      </Button>
    </div>
  )
}
