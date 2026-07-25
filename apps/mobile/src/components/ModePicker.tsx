/** Runtime mode chip row (Plan / Sandbox / Edits / Full) shared by the thread
 * composer and the new-session form. */
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { RuntimeMode } from '@shared/provider-events'
import { colors } from '../theme'

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
    gap: 6,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 12,
    backgroundColor: colors.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  chipActive: {
    backgroundColor: 'rgba(79, 142, 247, 0.18)',
    borderColor: colors.accent,
  },
  chipText: {
    color: colors.textDim,
    fontSize: 12,
    fontWeight: '500',
  },
  chipTextActive: {
    color: colors.accent,
  },
})
