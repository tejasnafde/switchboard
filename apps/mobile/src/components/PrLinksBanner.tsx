/**
 * The pull requests linked to a chat, one line each: number, merged/closed
 * when the backend read it, how it was linked, and the repository (last, so a
 * long name is what gets cut off). Unlink leaves a tombstone on the backend,
 * so automatic linking never re-adds it. A long list scrolls inside a capped
 * height, so the feed keeps its room.
 */
import React from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { phoneLinkRowText, unlinkPrLabel, type PrLink } from '@shared/pull-request-links'
import { prKey } from '@shared/pull-requests'
import { styles } from '../screens/thread-screen.styles'

export function PrLinksBanner({ links, onUnlink }: { links: PrLink[]; onUnlink: (link: PrLink) => void }) {
  if (links.length === 0) return null
  return (
    <ScrollView style={[styles.forkBanner, styles.prLinksBanner]} accessibilityRole="summary" testID="pr-links-banner">
      {links.map((link) => (
        <View key={prKey(link.ref)} style={styles.compactBanner}>
          <Text style={[styles.forkBannerText, styles.compactBannerText]} numberOfLines={1}>{phoneLinkRowText(link)}</Text>
          <Pressable onPress={() => onUnlink(link)} accessibilityRole="button" accessibilityLabel={unlinkPrLabel(link.ref)} hitSlop={8}>
            <Text style={styles.forkBannerText}>Unlink</Text>
          </Pressable>
        </View>
      ))}
    </ScrollView>
  )
}
