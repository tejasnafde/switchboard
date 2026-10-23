/**
 * Steer | Queue in the composer footer while a turn runs. A screen reader
 * hears one switch whose state is the hint ("Steering the running turn · tap
 * to queue"); a tap on the other segment flips the next send.
 */
import React from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { QueueToggle } from '../lib/held-turns'
import { chat, colors, space, type } from '../theme'

const SEGMENTS = [
  { queues: false, label: 'Steer' },
  { queues: true, label: 'Queue' },
] as const

export function QueueSegment({
  toggle,
  flipped,
  onFlip,
}: {
  toggle: QueueToggle
  flipped: boolean
  onFlip: () => void
}) {
  return (
    <View
      accessible
      accessibilityRole="switch"
      accessibilityState={{ checked: flipped }}
      accessibilityLabel={toggle.accessibilityLabel}
      accessibilityValue={{ text: toggle.hint }}
      accessibilityActions={[{ name: 'activate' }]}
      onAccessibilityAction={onFlip}
      testID="queue-next-toggle"
      style={styles.target}
    >
      <View style={styles.segment}>
        {SEGMENTS.map(({ queues, label }) => {
          const selected = toggle.queues === queues
          return (
            <Pressable
              key={label}
              onPress={selected ? undefined : onFlip}
              hitSlop={{ top: 8, bottom: 8 }}
              testID={`queue-segment-${label.toLowerCase()}`}
              style={[styles.option, selected && styles.optionOn]}
            >
              <Text style={[styles.optionText, selected && styles.optionTextOn]}>{label}</Text>
            </Pressable>
          )
        })}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  target: { minHeight: chat.target, justifyContent: 'center' },
  segment: {
    flexDirection: 'row',
    height: 32,
    borderRadius: space.sm,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    overflow: 'hidden',
  },
  option: { paddingHorizontal: space.md, justifyContent: 'center' },
  optionOn: { backgroundColor: colors.surfaceRaised },
  optionText: { color: colors.textDim, ...type.meta },
  optionTextOn: { color: colors.text },
})
