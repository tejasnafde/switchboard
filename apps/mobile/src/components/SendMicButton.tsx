/**
 * The composer's primary button: send, or press-and-hold to dictate.
 *
 * WhatsApp's gesture, adapted. With something to send it sends. Empty, it is a
 * mic: hold to dictate, slide up to lock hands-free, slide sideways to cancel.
 * Dictation here transcribes into the draft rather than attaching a voice clip,
 * so releasing stops transcribing and leaves the text for editing.
 *
 * PanResponder rather than react-native-gesture-handler on purpose: it is part
 * of React Native, so this needs no native module and ships over OTA.
 */
import React, { memo, useMemo, useRef, useState } from 'react'
import { Animated, Easing, PanResponder, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { composerMode, gestureOutcome, holdHint, type GestureOutcome } from '../lib/composer'
import type { Dictation } from '../hooks/useDictation'
import { colors, radius, space, type } from '../theme'

/** Hold this long before a press becomes dictation, so a tap stays a tap. */
const HOLD_MS = 220

export const SendMicButton = memo(function SendMicButton({
  canSend,
  isRunning,
  dictation,
  onSend,
  onStopTurn,
}: {
  canSend: boolean
  isRunning: boolean
  dictation: Dictation
  onSend: () => void
  onStopTurn: () => void
}) {
  const [locked, setLocked] = useState(false)
  const [holding, setHolding] = useState(false)
  const [outcome, setOutcome] = useState<GestureOutcome>('none')

  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startedRef = useRef(false)
  const movedRef = useRef(false)
  // The responder is built once, so live values it needs come through refs.
  const state = useRef({ canSend, isRunning, locked })
  state.current = { canSend, isRunning, locked }

  const mode = composerMode({ canSend, isRunning, listening: dictation.listening, locked })

  const clearHold = (): void => {
    if (holdTimer.current) clearTimeout(holdTimer.current)
    holdTimer.current = null
  }

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        // Claim the move too, or the parent ScrollView steals the drag.
        onMoveShouldSetPanResponder: () => true,

        onPanResponderGrant: () => {
          movedRef.current = false
          startedRef.current = false
          setOutcome('none')
          // A press with text to send, a live dictation to end, or a turn to
          // stop is a tap - only an empty composer arms the hold-to-dictate.
          if (state.current.canSend || state.current.locked) return
          setHolding(true)
          holdTimer.current = setTimeout(() => {
            void dictation.start().then((ok) => {
              startedRef.current = ok
              if (!ok) setHolding(false)
            })
          }, HOLD_MS)
        },

        onPanResponderMove: (_e, g) => {
          if (!startedRef.current && !holdTimer.current) return
          if (Math.abs(g.dx) > 4 || Math.abs(g.dy) > 4) movedRef.current = true
          setOutcome(gestureOutcome(g.dx, g.dy))
        },

        onPanResponderRelease: (_e, g) => {
          clearHold()
          setHolding(false)
          const settled = gestureOutcome(g.dx, g.dy)
          setOutcome('none')

          // Dictation was running: the drag decides what release means.
          if (startedRef.current) {
            startedRef.current = false
            if (settled === 'locked') {
              setLocked(true)
              return
            }
            dictation.stop()
            return
          }

          // No dictation started, and no real drag: a tap.
          if (movedRef.current) return
          const current = state.current
          if (current.locked) {
            dictation.stop()
            setLocked(false)
            return
          }
          if (current.canSend) {
            onSend()
            return
          }
          if (current.isRunning) onStopTurn()
        },

        onPanResponderTerminate: () => {
          clearHold()
          setHolding(false)
          setOutcome('none')
          if (startedRef.current) {
            startedRef.current = false
            dictation.stop()
          }
        },
      }),
    [dictation, onSend, onStopTurn],
  )

  // Breathing ring while dictating, so recording is unmistakable.
  const pulse = useRef(new Animated.Value(0)).current
  React.useEffect(() => {
    if (!dictation.listening) {
      pulse.setValue(0)
      return
    }
    const loop = Animated.loop(
      Animated.timing(pulse, {
        toValue: 1,
        duration: 1100,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }),
    )
    loop.start()
    return () => loop.stop()
  }, [dictation.listening, pulse])

  const cancelling = outcome === 'cancelled'
  const tint = cancelling ? colors.red : colors.accent

  return (
    <View style={styles.wrap}>
      {/* Hint floats above so it never resizes the composer. */}
      {(holding || dictation.listening) && !locked && (
        <View style={styles.hint} pointerEvents="none">
          <Text style={styles.hintText}>{holdHint(outcome)}</Text>
        </View>
      )}

      <View
        {...responder.panHandlers}
        accessibilityRole="button"
        accessibilityLabel={
          mode === 'send'
            ? 'Send message'
            : mode === 'stop-dictation'
              ? 'Stop dictation'
              : mode === 'stop-turn'
                ? 'Stop the agent'
                : 'Hold to dictate, slide up to lock'
        }
        style={[
          styles.button,
          mode === 'send' && styles.buttonSend,
          mode === 'stop-turn' && styles.buttonStop,
        ]}
      >
        {dictation.listening && (
          <Animated.View
            style={[
              styles.pulseRing,
              {
                borderColor: tint,
                opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0] }),
                transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.5] }) }],
              },
            ]}
          />
        )}
        <Glyph mode={mode} tint={dictation.listening ? tint : undefined} />
      </View>
    </View>
  )
})

function Glyph({ mode, tint }: { mode: ReturnType<typeof composerMode>; tint?: string }) {
  switch (mode) {
    case 'send':
      return <Ionicons name="arrow-up" size={16} color="#fff" />
    case 'stop-turn':
      return <Ionicons name="stop" size={16} color="#fff" />
    case 'stop-dictation':
      return <Ionicons name="stop" size={16} color={tint ?? '#fff'} />
    default:
      return <Ionicons name="mic" size={18} color={tint ?? colors.textDim} />
  }
}

const styles = StyleSheet.create({
  wrap: { justifyContent: 'center', alignItems: 'center' },
  hint: {
    position: 'absolute',
    bottom: 44 + space.sm,
    right: 0,
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
  },
  hintText: { color: colors.textDim, ...type.monoSm },
  button: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  buttonSend: { backgroundColor: colors.accent },
  buttonStop: { backgroundColor: colors.red },
  pulseRing: { position: 'absolute', width: 44, height: 44, borderRadius: 22, borderWidth: 2 },
})
