/**
 * A review pill waiting in the composer ("Work on PR", "Ask the agent"). The
 * next send carries it before the typed text; the cross drops it.
 */
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { colors, fonts, radius, space, type } from '../theme'

export function ReviewPillChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <View style={styles.chip} testID="review-pill-chip">
      <Ionicons name="git-pull-request-outline" size={14} color={colors.accent} />
      <Text style={styles.kind}>Review</Text>
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
      <Pressable onPress={onRemove} accessibilityRole="button" accessibilityLabel="Remove review context" hitSlop={10}>
        <Ionicons name="close" size={14} color={colors.textDim} />
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    alignSelf: 'flex-start',
    maxWidth: '100%',
    borderRadius: radius.sm,
    backgroundColor: colors.accentWash,
    paddingHorizontal: space.sm,
    paddingVertical: 4,
    marginBottom: space.sm,
  },
  kind: { fontFamily: fonts.display, fontSize: 12, color: colors.accent },
  label: { ...type.bodySm, color: colors.text, flexShrink: 1 },
})
