/**
 * The Snooze sheet of a Home > Recents row: the presets resolved when it
 * opened, each with its wake time, and "Until PR #n changes" once the chat's
 * links say it has an open PR. A refusal shows on the sheet's last line.
 */
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { colors, radius, space, type, HIT } from '../theme'
import type { SnoozeSheetItem } from '../lib/snooze-sheet'

export function SnoozeSheet({
  title,
  items,
  notice,
  busy,
  onPick,
  onClose,
}: {
  title: string
  items: SnoozeSheetItem[]
  notice: string | null
  busy: boolean
  onPick: (item: SnoozeSheetItem) => void
  onClose: () => void
}) {
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()} testID="snooze-sheet">
          <View style={styles.grabber} />
          <Text style={styles.title}>Snooze</Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {title}
          </Text>
          {items.map((item) => (
            <Pressable
              key={item.key}
              testID={`snooze-${item.choice.kind === 'pr' ? 'pr' : item.label}`}
              accessibilityRole="button"
              disabled={busy}
              onPress={() => onPick(item)}
              style={({ pressed }) => [styles.item, pressed && styles.pressed]}
            >
              <Text style={styles.label}>{item.label}</Text>
              {item.detail !== '' && <Text style={styles.detail}>{item.detail}</Text>}
            </Pressable>
          ))}
          {notice !== null && (
            <Text style={styles.notice} accessibilityLiveRegion="polite">
              {notice}
            </Text>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingTop: space.sm,
    paddingBottom: space.xl,
    paddingHorizontal: space.lg,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderStrong,
    marginBottom: space.sm,
  },
  title: { ...type.heading, fontSize: 18, color: colors.text },
  subtitle: { ...type.bodySm, color: colors.textDim, paddingBottom: space.sm },
  item: {
    minHeight: HIT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  label: { ...type.body, color: colors.text },
  detail: { ...type.monoSm, color: colors.textDim },
  notice: { ...type.bodySm, color: colors.amber, paddingTop: space.sm },
  pressed: { opacity: 0.55 },
})
