/**
 * The composer's inline voice note. Session management moved to
 * hooks/useDictation when the mic became a gesture on the send button.
 */
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { createLogger } from '@shared/logger'
import { colors, radius, space, type } from '../theme'
import { useDictation, type VoiceNote } from '../hooks/useDictation'

const log = createLogger('mobile:mic')

export type { VoiceNote }

const NOTE_TTL_MS = 6000

/** Error codes that end a session without anything worth telling the user. */
const QUIET_ERROR_CODES = new Set(['aborted', 'no-speech', 'speech-timeout'])

/**
 * Plain mic toggle, for fields with no send button of their own (the new-session
 * first message). The chat composer uses SendMicButton's hold gesture instead.
 */
export function MicButton({
  draft,
  onDraft,
  onNote,
}: {
  draft: string
  onDraft: (text: string) => void
  onNote: (note: VoiceNote | null) => void
}) {
  const dictation = useDictation({ draft, onDraft, onNote })
  if (!dictation.available) return null
  return (
    <Pressable
      onPress={() => (dictation.listening ? dictation.stop() : void dictation.start())}
      accessibilityRole="button"
      accessibilityLabel={dictation.listening ? 'Stop dictation' : 'Start dictation'}
      hitSlop={8}
      style={({ pressed }) => [styles.plainMic, pressed && styles.pressed]}
    >
      <Ionicons
        name="mic"
        size={18}
        color={dictation.listening ? colors.accent : colors.textDim}
      />
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
  plainMic: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
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
