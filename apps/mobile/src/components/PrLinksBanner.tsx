/**
 * The pull requests linked to a chat, one line each: number, repository,
 * merged/closed when the backend read it, and how it was linked. Unlink
 * leaves a tombstone on the backend, so automatic linking never re-adds it.
 */
import React from 'react'
import { Pressable, Text, View } from 'react-native'
import { phoneLinkRowText, type PrLink } from '@shared/pull-request-links'
import { prKey } from '@shared/pull-requests'
import { styles } from '../screens/thread-screen.styles'

export function PrLinksBanner({ links, onUnlink }: { links: PrLink[]; onUnlink: (link: PrLink) => void }) {
  if (links.length === 0) return null
  return (
    <View style={styles.forkBanner} accessibilityRole="summary" testID="pr-links-banner">
      {links.map((link) => (
        <View key={prKey(link.ref)} style={styles.compactBanner}>
          <Text style={[styles.forkBannerText, styles.compactBannerText]} numberOfLines={1}>{phoneLinkRowText(link)}</Text>
          <Pressable onPress={() => onUnlink(link)} accessibilityRole="button" accessibilityLabel={`Unlink pull request ${link.ref.number}`} hitSlop={8}>
            <Text style={styles.forkBannerText}>Unlink</Text>
          </Pressable>
        </View>
      ))}
    </View>
  )
}
