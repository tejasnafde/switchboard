/**
 * The line above the composer of a snoozed chat: "Snoozed until 20:00" with
 * Wake now, like the desktop's composer line. The chat stays open after a
 * snooze from elsewhere; its Home row sits in the Snoozed shelf.
 */
import { useEffect, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { isSnoozed, snoozeLineText } from '@shared/chat-snooze'
import type { RecentSession } from '../lib/home-recents'
import { styles } from '../screens/thread-screen.styles'

export function SnoozeLine({
  session,
  onWake,
}: {
  session: Pick<RecentSession, 'snoozedAt' | 'snoozedUntil' | 'snoozePr'> | undefined
  onWake: () => Promise<string | null>
}) {
  const [busy, setBusy] = useState(false)
  // A refusal belongs to the snooze it answered: a later snooze starts without it.
  const [note, setNote] = useState<{ snoozedAt: number; text: string } | null>(null)
  const [now, setNow] = useState(() => new Date())
  const snoozedAt = session?.snoozedAt ?? null
  // Its own clock: the day in "Tue 09:00" must drop at midnight on an idle thread.
  useEffect(() => {
    if (snoozedAt === null) return
    const timer = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(timer)
  }, [snoozedAt])
  if (!session || snoozedAt === null || !isSnoozed({ snoozedAt })) return null

  const wake = async () => {
    setBusy(true)
    const text = await onWake()
    setNote(text === null ? null : { snoozedAt, text })
    setBusy(false)
  }
  const shown = note?.snoozedAt === snoozedAt ? note.text : null

  return (
    <View style={styles.forkBanner} testID="snooze-line">
      <View style={styles.snoozeLineRow}>
        <Text style={[styles.limitResumeTitle, styles.snoozeLineText]} accessibilityLiveRegion="polite">
          {snoozeLineText(session.snoozedUntil ?? null, session.snoozePr ?? null, now)}
        </Text>
        <Pressable
          onPress={() => void wake()}
          disabled={busy}
          style={[styles.actionButton, styles.iterateButton, busy && styles.buttonDisabled]}
          accessibilityRole="button"
          accessibilityLabel="Wake now"
        >
          <Text style={styles.iterateLabel}>Wake now</Text>
        </Pressable>
      </View>
      {shown && (
        <Text style={styles.limitResumeNote} accessibilityRole="alert">
          {shown}
        </Text>
      )}
    </View>
  )
}
