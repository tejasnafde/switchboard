/**
 * The pull requests linked to a chat: one chip in the header ("#9 +1") that
 * opens a bottom sheet with one row per link. Unlink lives in the sheet and
 * leaves a tombstone on the backend, so automatic linking never re-adds it.
 */
import React from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import {
  phoneLinkRowText,
  phoneLinkSheetRow,
  prLinksChipLabel,
  unlinkPrLabel,
  type PrLink,
} from '@shared/pull-request-links'
import { prKey } from '@shared/pull-requests'
import { chat, colors, radius, space, type } from '../theme'

export function PrLinksChip({ links, onPress }: { links: PrLink[]; onPress: () => void }) {
  if (links.length === 0) return null
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Linked pull requests, ${links.length}`}
      testID="pr-links-chip"
      style={styles.chipTarget}
    >
      {({ pressed }) => (
        <View style={[styles.chip, pressed && styles.pressed]}>
          <Ionicons name="git-merge-outline" size={14} color={colors.textDim} />
          <Text style={styles.chipText} numberOfLines={1}>
            {prLinksChipLabel(links)}
          </Text>
        </View>
      )}
    </Pressable>
  )
}

export function PrLinksSheet({
  visible,
  links,
  onUnlink,
  onClose,
}: {
  visible: boolean
  links: PrLink[]
  onUnlink: (link: PrLink) => void
  onClose: () => void
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close linked pull requests">
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()} testID="pr-links-sheet">
          <View style={styles.handle} />
          <Text style={styles.heading} accessibilityRole="header">
            Linked pull requests
          </Text>
          <ScrollView>
            {links.map((link) => {
              const row = phoneLinkSheetRow(link)
              const number = `#${link.ref.number}`
              return (
                <View key={prKey(link.ref)} style={styles.row}>
                  <Ionicons name="git-merge-outline" size={18} color={colors.accent} />
                  <View style={styles.rowText} accessible accessibilityLabel={phoneLinkRowText(link)}>
                    <Text style={styles.primary} numberOfLines={1}>
                      <Text style={styles.number}>{number}</Text>
                      {row.primary.slice(number.length)}
                    </Text>
                    <Text style={styles.secondary} numberOfLines={1}>
                      {row.secondary}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => onUnlink(link)}
                    accessibilityRole="button"
                    accessibilityLabel={unlinkPrLabel(link.ref)}
                    style={({ pressed }) => [styles.unlink, pressed && styles.pressed]}
                  >
                    <Text style={styles.unlinkText}>Unlink</Text>
                  </Pressable>
                </View>
              )
            })}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

const styles = StyleSheet.create({
  chipTarget: { minHeight: chat.target, justifyContent: 'center', paddingHorizontal: 2 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 32,
    paddingLeft: space.sm,
    paddingRight: 10,
    borderRadius: space.sm,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  chipText: { color: colors.text, ...type.meta },
  pressed: { opacity: 0.6 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surfaceRaised,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingTop: space.sm,
    paddingBottom: space.xl,
    maxHeight: '70%',
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
    paddingLeft: space.xl,
    paddingRight: space.md,
  },
  rowText: { flex: 1, minWidth: 0 },
  primary: { color: colors.text, fontSize: 15, lineHeight: 20 },
  number: { fontWeight: '600' },
  secondary: { color: colors.textDim, ...type.meta },
  unlink: {
    minHeight: chat.target,
    paddingHorizontal: space.md,
    justifyContent: 'center',
    borderRadius: radius.sm,
  },
  unlinkText: { color: colors.accent, fontSize: 14, fontWeight: '600' },
})
