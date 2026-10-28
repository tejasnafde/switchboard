/**
 * Composer file attachments: the Photos or Files sheet the attach button
 * opens, the file chips, and the refusal lines. Rules in lib/file-attachments.ts.
 */
import React from 'react'
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import type { ComposerFile } from '../lib/file-attachments'
import { ComposerChip } from './ReviewPillChip'
import { chat, colors, space, type } from '../theme'

export type AttachSource = 'photos' | 'files'

function SourceRow({
  icon,
  label,
  onPress,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name']
  label: string
  onPress: () => void
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <Ionicons name={icon} size={20} color={colors.textDim} />
      <Text style={styles.rowLabel}>{label}</Text>
    </Pressable>
  )
}

/**
 * Photos or Files. The caller opens the picker from `onDismiss`, once the
 * sheet is gone: iOS does not present a picker over a modal that is closing.
 */
export function AttachSheet({
  visible,
  onPick,
  onClose,
  onDismiss,
}: {
  visible: boolean
  onPick: (source: AttachSource) => void
  onClose: () => void
  onDismiss: () => void
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} onDismiss={onDismiss}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close attach">
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()} testID="attach-sheet">
          <View style={styles.handle} />
          <Text style={styles.heading} accessibilityRole="header">
            Attach
          </Text>
          <SourceRow icon="images-outline" label="Photos" onPress={() => onPick('photos')} />
          <SourceRow icon="document-outline" label="Files" onPress={() => onPick('files')} />
        </Pressable>
      </Pressable>
    </Modal>
  )
}

export function FileChips({ files, onRemove }: { files: ComposerFile[]; onRemove: (id: string) => void }) {
  if (files.length === 0) return null
  return (
    <View style={styles.chips}>
      {files.map((f) => (
        <ComposerChip
          key={f.id}
          icon="document-outline"
          kind="File"
          label={f.label}
          busy={!f.path}
          removeLabel={`Remove ${f.name}`}
          onRemove={() => onRemove(f.id)}
          testID="file-chip"
        />
      ))}
    </View>
  )
}

/** Files that were not attached, one line each with the reason. */
export function AttachRefusals({ lines, onDismiss }: { lines: string[]; onDismiss: () => void }) {
  if (lines.length === 0) return null
  return (
    <View style={styles.refusals} accessibilityRole="alert" testID="attach-refusals">
      <View style={styles.refusalLines}>
        {lines.map((line, i) => (
          <Text key={i} style={styles.refusalText}>
            {line}
          </Text>
        ))}
      </View>
      <Pressable onPress={onDismiss} accessibilityRole="button" accessibilityLabel="Dismiss" hitSlop={10}>
        <Ionicons name="close" size={14} color={colors.textDim} />
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surfaceRaised,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingTop: space.sm,
    paddingBottom: space.xl,
  },
  handle: {
    alignSelf: 'center',
    width: 32,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.textFaint,
    marginTop: space.sm,
    marginBottom: 18,
  },
  heading: { color: colors.text, ...type.heading, paddingHorizontal: space.xl, paddingBottom: space.md },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: chat.sheetRow,
    paddingHorizontal: space.xl,
  },
  rowLabel: { color: colors.text, fontSize: 15, lineHeight: 20 },
  pressed: { opacity: 0.6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', columnGap: space.sm },
  refusals: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, marginBottom: space.sm },
  refusalLines: { flex: 1, minWidth: 0 },
  refusalText: { ...type.bodySm, color: colors.red },
})
