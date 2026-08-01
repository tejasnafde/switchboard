/** Runtime mode control (Plan / Sandbox / Edits / Full).
 *
 * Defaults to a compact dropdown trigger, because in the thread composer a chip
 * per mode ate the whole row. The new-session form has the full width of a
 * scrolling page, so it asks for the inline chip row instead. */
import { useState } from 'react'
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import type { RuntimeMode } from '@shared/provider-events'
import { colors, fonts, radius, space, type, HIT } from '../theme'

const MODES: { mode: RuntimeMode; label: string }[] = [
  { mode: 'plan', label: 'Plan' },
  { mode: 'sandbox', label: 'Sandbox' },
  { mode: 'accept-edits', label: 'Edits' },
  { mode: 'full-access', label: 'Full' },
]

export function ModePicker({
  value,
  onChange,
  variant = 'trigger',
}: {
  value: RuntimeMode
  onChange: (m: RuntimeMode) => void
  variant?: 'trigger' | 'row'
}) {
  const [open, setOpen] = useState(false)

  if (variant === 'row') {
    return (
      <View style={styles.row}>
        {MODES.map(({ mode, label }) => {
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

  const label = MODES.find((m) => m.mode === value)?.label ?? 'Mode'

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`Runtime mode: ${label}`}
        style={({ pressed }) => [styles.trigger, pressed && styles.pressed]}
      >
        <Text style={styles.triggerText} numberOfLines={1}>
          {label}
        </Text>
        <Ionicons name="chevron-down" size={11} color={colors.textDim} />
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.title}>Runtime mode</Text>
            {MODES.map(({ mode, label: rowLabel }) => {
              const active = value === mode
              return (
                <Pressable
                  key={mode}
                  onPress={() => {
                    setOpen(false)
                    onChange(mode)
                  }}
                  style={({ pressed }) => [
                    styles.sheetRow,
                    active && styles.sheetRowActive,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={[styles.sheetRowText, active && styles.sheetRowTextActive]}>
                    {rowLabel}
                  </Text>
                  {active && <Ionicons name="checkmark" size={14} color={colors.accent} />}
                </Pressable>
              )
            })}
          </Pressable>
        </Pressable>
      </Modal>
    </>
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
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    maxWidth: 140,
  },
  triggerText: {
    color: colors.textDim,
    fontSize: 12,
    flexShrink: 1,
  },
  pressed: {
    opacity: 0.6,
  },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.xl,
  },
  title: { color: colors.text, ...type.heading, marginBottom: space.sm },
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    minHeight: HIT,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
  },
  sheetRowActive: { backgroundColor: colors.surfaceRaised },
  sheetRowText: { color: colors.text, fontFamily: fonts.display, fontSize: 15 },
  sheetRowTextActive: { color: colors.accent },
})
