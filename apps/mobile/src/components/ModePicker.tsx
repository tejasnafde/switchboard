/** Runtime mode chip row (Plan / Sandbox / Edits / Full) shared by the thread
 * composer and the new-session form. */
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { RuntimeMode } from '@shared/provider-events'
import { colors, fonts, radius, space } from '../theme'

const MODE_CHIPS: { mode: RuntimeMode; label: string }[] = [
  { mode: 'plan', label: 'Plan' },
  { mode: 'sandbox', label: 'Sandbox' },
  { mode: 'accept-edits', label: 'Edits' },
  { mode: 'full-access', label: 'Full' },
]

export function ModePicker({ value, onChange }: { value: RuntimeMode; onChange: (m: RuntimeMode) => void }) {
  return (
    <View style={styles.row}>
      {MODE_CHIPS.map(({ mode, label }) => {
        const active = value === mode
        return (
          <Pressable
            key={mode}
            onPress={() => onChange(mode)}
            style={[styles.chip, active && styles.chipActive]}
          >
            <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: space.sm,
  },
  chip: {
    paddingHorizontal: space.md,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  chipActive: {
    backgroundColor: colors.accentWash,
    borderColor: colors.accent,
  },
  chipText: {
    fontFamily: fonts.display,
    fontSize: 12,
    color: colors.textDim,
  },
  chipTextActive: {
    color: colors.accent,
  },
})
