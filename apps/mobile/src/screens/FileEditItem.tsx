import { memo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { CompactDiffLine } from '@shared/compact-file-diff'
import { colors, fonts } from '../theme'
import { fileEditDiff, type FileGroupRow } from '../lib/file-groups'
import type { FeedItem } from '../stores/chat'
import { styles as feed } from './thread-screen.styles'

const MARKER: Record<CompactDiffLine['kind'], string> = { added: '+', removed: '-', context: ' ', omitted: ' ' }

/**
 * One changed file: path, line counts and where it changed. A tap shows or
 * hides its read-only diff (Review / Hide); a file whose contents did not
 * change has no diff and no tap.
 */
export const FileEditItem = memo(function FileEditItem({
  item,
  backendLabel,
  expanded,
  onToggle,
}: {
  item: Extract<FeedItem, { kind: 'fileEdit' }>
  backendLabel: string
  expanded: boolean
  onToggle: (id: string) => void
}) {
  const diff = fileEditDiff(item)
  const reviewable = diff.lines.length > 0
  const approx = diff.countsExact ? '' : '~'
  const open = reviewable && expanded

  return (
    <View style={[feed.itemBlock, styles.card]}>
      <Pressable
        onPress={() => onToggle(item.id)}
        disabled={!reviewable}
        accessibilityRole={reviewable ? 'button' : undefined}
        accessibilityState={reviewable ? { expanded: open } : undefined}
        testID={`file-edit:${item.id}`}
        style={({ pressed }) => [styles.header, pressed && styles.pressed]}
      >
        <View style={styles.headerText}>
          <Text style={styles.path} numberOfLines={1}>
            {item.relPath}
          </Text>
          <View style={styles.metaRow}>
            <Text style={styles.added}>
              {approx}+{diff.addedLines}
            </Text>
            <Text style={styles.removed}>
              {approx}-{diff.removedLines}
            </Text>
            <Text style={styles.where} numberOfLines={1}>
              Changed on {backendLabel} · {item.changeKind}
            </Text>
          </View>
        </View>
        {reviewable ? <Text style={styles.toggle}>{open ? 'Hide' : 'Review'}</Text> : null}
      </Pressable>
      {open ? (
        <>
          <View style={styles.diff} testID={`file-diff:${item.id}`}>
            {diff.lines.map((line, index) => (
              <DiffRow key={index} line={line} />
            ))}
          </View>
          <Text style={styles.footer}>
            {diff.truncated ? 'Read-only preview · large diff truncated' : 'Read-only preview'}
          </Text>
        </>
      ) : null}
    </View>
  )
})

/** One turn's changed files, folded; a tap shows or hides that turn's file rows. */
export const FileGroupItem = memo(function FileGroupItem({
  row,
  onToggle,
}: {
  row: FileGroupRow
  onToggle: (id: string) => void
}) {
  return (
    <View style={[feed.itemBlock, styles.card]}>
      <Pressable
        onPress={() => onToggle(row.id)}
        accessibilityRole="button"
        accessibilityState={{ expanded: row.expanded }}
        testID="file-group"
        style={({ pressed }) => [styles.header, pressed && styles.pressed]}
      >
        <Text style={styles.groupLabel}>{row.label}</Text>
        <Text style={styles.added}>+{row.added}</Text>
        <Text style={[styles.removed, styles.groupRemoved]}>-{row.removed}</Text>
        <Text style={styles.toggle}>{row.expanded ? 'Hide' : 'Show'}</Text>
      </Pressable>
    </View>
  )
})

function DiffRow({ line }: { line: CompactDiffLine }) {
  const tone =
    line.kind === 'added'
      ? styles.addedLine
      : line.kind === 'removed'
        ? styles.removedLine
        : line.kind === 'omitted'
          ? styles.omittedLine
          : styles.contextLine
  return (
    <View style={[styles.row, line.kind === 'added' && styles.addedRow, line.kind === 'removed' && styles.removedRow]}>
      <Text style={styles.lineNo}>{line.oldLine ?? ''}</Text>
      <Text style={styles.lineNo}>{line.newLine ?? ''}</Text>
      <Text style={[styles.marker, tone]}>{MARKER[line.kind]}</Text>
      <Text style={[styles.code, tone]} numberOfLines={1}>
        {line.text}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    padding: 14,
    gap: 9,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(63,185,80,0.22)',
    backgroundColor: colors.surface,
  },
  header: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
  },
  pressed: {
    backgroundColor: colors.surfaceRaised,
  },
  groupLabel: {
    flex: 1,
    color: colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
  groupRemoved: {
    marginLeft: 8,
  },
  headerText: {
    flex: 1,
    gap: 2,
  },
  path: {
    color: colors.text,
    fontFamily: fonts.monoMedium,
    fontSize: 13,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  added: {
    color: colors.green,
    fontFamily: fonts.mono,
    fontSize: 12,
  },
  removed: {
    color: colors.red,
    fontFamily: fonts.mono,
    fontSize: 12,
  },
  where: {
    flexShrink: 1,
    color: colors.textDim,
    fontSize: 12,
  },
  toggle: {
    marginLeft: 12,
    color: colors.accent,
    fontSize: 13,
    fontWeight: '600',
  },
  diff: {
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: colors.surfaceRaised,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  addedRow: {
    backgroundColor: 'rgba(63,185,80,0.09)',
  },
  removedRow: {
    backgroundColor: 'rgba(248,81,73,0.09)',
  },
  lineNo: {
    width: 28,
    textAlign: 'right',
    color: colors.textDim,
    fontFamily: fonts.mono,
    fontSize: 10,
  },
  marker: {
    paddingHorizontal: 7,
    fontFamily: fonts.mono,
  },
  code: {
    flex: 1,
    fontFamily: fonts.mono,
    fontSize: 11,
  },
  addedLine: { color: colors.green },
  removedLine: { color: colors.red },
  omittedLine: { color: colors.textDim },
  contextLine: { color: colors.text },
  footer: {
    color: colors.textDim,
    fontSize: 11,
  },
})
