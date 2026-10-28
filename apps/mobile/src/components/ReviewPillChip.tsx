/**
 * Chips waiting in the composer: a review pill ("Work on PR", "Ask the agent")
 * that the next send carries before the typed text, and attached files that it
 * carries after it. The cross drops the chip.
 */
import type { ComponentProps } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { colors, fonts, radius, space, type } from '../theme'

export function ComposerChip({
  icon,
  kind,
  label,
  removeLabel,
  busy,
  onRemove,
  testID,
}: {
  icon: ComponentProps<typeof Ionicons>['name']
  kind: string
  label: string
  removeLabel: string
  /** A spinner in place of the icon, for an upload still running. */
  busy?: boolean
  onRemove: () => void
  testID?: string
}) {
  return (
    <View style={styles.chip} testID={testID}>
      {busy ? (
        <ActivityIndicator size="small" color={colors.accent} accessibilityLabel={`Uploading ${label}`} />
      ) : (
        <Ionicons name={icon} size={14} color={colors.accent} />
      )}
      <Text style={styles.kind}>{kind}</Text>
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
      <Pressable onPress={onRemove} accessibilityRole="button" accessibilityLabel={removeLabel} hitSlop={10}>
        <Ionicons name="close" size={14} color={colors.textDim} />
      </Pressable>
    </View>
  )
}

export function ReviewPillChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <ComposerChip
      icon="git-pull-request-outline"
      kind="Review"
      label={label}
      removeLabel="Remove review context"
      onRemove={onRemove}
      testID="review-pill-chip"
    />
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
