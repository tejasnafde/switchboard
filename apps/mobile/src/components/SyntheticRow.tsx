import React, { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import {
  syntheticPartDetail,
  syntheticPartLabel,
  syntheticPartTone,
  type SyntheticTone,
  type SyntheticUserPart,
} from '@shared/synthetic-message'
import { colors, space, type } from '../theme'

const TONE_COLOR: Record<SyntheticTone, string> = {
  ok: colors.green,
  error: colors.red,
  warn: colors.amber,
  muted: colors.textFaint,
}

/** Compact row for a provider-generated user-role block. Tap shows ids and paths, or full output. */
export function SyntheticRow({ part }: { part: SyntheticUserPart }) {
  const [open, setOpen] = useState(false)
  const label = syntheticPartLabel(part)
  const detail = syntheticPartDetail(part)
  // Command output can run to many lines; the clamp lifts on tap.
  const expandable = !!detail || part.kind === 'command-output'
  return (
    <Pressable
      disabled={!expandable}
      onPress={() => setOpen((v) => !v)}
      accessibilityLabel={label}
      style={styles.row}
    >
      <View style={styles.line}>
        <View style={[styles.dot, { backgroundColor: TONE_COLOR[syntheticPartTone(part)] }]} />
        <Text style={styles.label} numberOfLines={open ? undefined : 2}>{label}</Text>
      </View>
      {open && detail && <Text style={styles.detail} selectable>{detail}</Text>}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: { paddingVertical: space.xs },
  line: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  dot: { width: 6, height: 6, borderRadius: 3 },
  label: { flex: 1, color: colors.textDim, ...type.bodySm },
  detail: { color: colors.textFaint, ...type.monoSm, paddingLeft: 14, paddingTop: space.xs },
})
