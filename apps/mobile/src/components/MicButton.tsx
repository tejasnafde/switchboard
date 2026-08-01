/**
 * Composer mic: dictates into a draft via src/lib/voice. Renders nothing when
 * voice is unavailable (Expo Go, or no recognizer on the device), so callers
 * can mount it unconditionally. Partial transcripts stream into the draft by
 * composing onto a base snapshot, which each finalized utterance extends so a
 * long continuous dictation keeps its earlier sentences; errors and the
 * permission-denied state surface through onNote as a brief inline note that
 * the parent renders with VoiceNoteBar.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Animated, Easing, Linking, Pressable, StyleSheet, Text, View } from 'react-native'
import { createLogger } from '@shared/logger'
import { colors, radius, space, type } from '../theme'
import {
  ensureVoicePermission,
  isVoiceAvailable,
  joinDraft,
  startListening,
  type VoiceSession,
} from '../lib/voice'

const log = createLogger('mobile:mic')

export type VoiceNote = { message: string; showSettingsLink?: boolean }

const NOTE_TTL_MS = 6000

/** Error codes that end a session without anything worth telling the user. */
const QUIET_ERROR_CODES = new Set(['aborted', 'no-speech', 'speech-timeout'])

export function MicButton({
  draft,
  onDraft,
  onNote,
}: {
  draft: string
  onDraft: (text: string) => void
  onNote: (note: VoiceNote | null) => void
}) {
  const available = useMemo(() => isVoiceAvailable(), [])
  const [listening, setListening] = useState(false)
  const sessionRef = useRef<VoiceSession | null>(null)
  const baseRef = useRef('')
  const noteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // The draft prop is only read when a session starts; a ref keeps the
  // press handler stable without re-subscribing on every keystroke.
  const draftRef = useRef(draft)
  draftRef.current = draft

  const postNote = useCallback(
    (note: VoiceNote) => {
      if (noteTimerRef.current) clearTimeout(noteTimerRef.current)
      onNote(note)
      // Permission notes carry the Settings action, so they stay until the
      // next interaction instead of vanishing mid-tap.
      if (!note.showSettingsLink) {
        noteTimerRef.current = setTimeout(() => onNote(null), NOTE_TTL_MS)
      }
    },
    [onNote],
  )

  useEffect(
    () => () => {
      if (noteTimerRef.current) clearTimeout(noteTimerRef.current)
      sessionRef.current?.stop()
    },
    [],
  )

  const toggle = useCallback(async () => {
    if (sessionRef.current && listening) {
      sessionRef.current.stop()
      return
    }
    onNote(null)
    const granted = await ensureVoicePermission()
    if (!granted) {
      postNote({ message: 'Microphone permission needed.', showSettingsLink: true })
      return
    }
    baseRef.current = draftRef.current
    const session = startListening({
      onPartial: (t) => onDraft(joinDraft(baseRef.current, t)),
      // A continuous session finalizes each utterance separately, so the base
      // absorbs it: without this the next sentence overwrites the last one.
      onFinal: (t) => {
        baseRef.current = joinDraft(baseRef.current, t)
        onDraft(baseRef.current)
      },
      onEnd: () => {
        sessionRef.current = null
        setListening(false)
      },
      onError: (message, code) => {
        if (QUIET_ERROR_CODES.has(code)) return
        if (code === 'not-allowed') {
          postNote({ message: 'Microphone permission needed.', showSettingsLink: true })
          return
        }
        postNote({ message: `Voice input failed: ${message}` })
      },
    })
    if (!session) {
      postNote({ message: 'Voice input failed to start.' })
      return
    }
    sessionRef.current = session
    setListening(true)
  }, [listening, onDraft, onNote, postNote])

  // Subtle pulse while recording: an accent ring breathing outward.
  const pulse = useRef(new Animated.Value(0)).current
  useEffect(() => {
    if (!listening) {
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
  }, [listening, pulse])

  if (!available) return null

  const glyphColor = listening ? colors.accent : colors.textDim

  return (
    <Pressable
      onPress={() => void toggle()}
      accessibilityRole="button"
      accessibilityLabel={listening ? 'Stop dictation' : 'Start dictation'}
      style={({ pressed }) => [styles.button, listening && styles.buttonListening, pressed && styles.pressed]}
    >
      {listening && (
        <Animated.View
          style={[
            styles.pulseRing,
            {
              opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0] }),
              transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.45] }) }],
            },
          ]}
        />
      )}
      <View style={styles.glyph}>
        <View style={[styles.micBody, { backgroundColor: glyphColor }]} />
        <View style={[styles.micStem, { backgroundColor: glyphColor }]} />
        <View style={[styles.micBase, { backgroundColor: glyphColor }]} />
      </View>
    </Pressable>
  )
}

/** Inline error / permission note rendered by the composer above the input. */
export function VoiceNoteBar({ note }: { note: VoiceNote }) {
  return (
    <View style={styles.noteRow}>
      <Text style={styles.noteText} numberOfLines={2}>
        {note.message}
      </Text>
      {note.showSettingsLink && (
        <Pressable
          onPress={() => Linking.openSettings().catch((err) => log.warn('openSettings failed', err))}
          hitSlop={8}
        >
          <Text style={styles.noteLink}>Open Settings</Text>
        </Pressable>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  button: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonListening: {
    borderColor: colors.accent,
    backgroundColor: colors.accentWash,
  },
  pressed: {
    opacity: 0.6,
  },
  pulseRing: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.accent,
  },
  glyph: {
    alignItems: 'center',
  },
  micBody: {
    width: 8,
    height: 13,
    borderRadius: 4,
  },
  micStem: {
    width: 2,
    height: 3,
  },
  micBase: {
    width: 10,
    height: 2,
    borderRadius: 1,
  },
  noteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    flexShrink: 1,
  },
  noteText: {
    ...type.bodySm,
    color: colors.red,
    flexShrink: 1,
  },
  noteLink: {
    ...type.bodySm,
    color: colors.accent,
  },
})
