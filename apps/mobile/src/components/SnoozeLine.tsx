/**
 * The line above the composer of a snoozed chat: "Snoozed until 20:00" with
 * Wake now, like the desktop's composer line. The chat stays open after a
 * snooze from elsewhere; its Home row sits in the Snoozed shelf.
 */
import { useState } from 'react'
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
  const [note, setNote] = useState<string | null>(null)
  if (!session || !isSnoozed({ snoozedAt: session.snoozedAt ?? null })) return null

  const wake = async () => {
    setBusy(true)
    setNote(await onWake())
    setBusy(false)
  }

  return (
    <View style={styles.forkBanner} testID="snooze-line">
      <View style={styles.snoozeLineRow}>
        <Text style={[styles.limitResumeTitle, styles.snoozeLineText]} accessibilityLiveRegion="polite">
          {snoozeLineText(session.snoozedUntil ?? null, session.snoozePr ?? null, new Date())}
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
      {note && (
        <Text style={styles.limitResumeNote} accessibilityRole="alert">
          {note}
        </Text>
      )}
    </View>
  )
}
