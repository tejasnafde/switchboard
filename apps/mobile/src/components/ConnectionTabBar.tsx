/**
 * The per-connection tab bar under Projects and Reviews. The Reviews badge
 * counts the pull requests that need you (`needsYouCount`), from the last
 * list read; it reads nothing itself.
 */
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { needsYouCount } from '@shared/pull-request-phone'
import { colors, fonts, space } from '../theme'
import { reviewsEntry, useReviewsStore } from '../stores/reviews'

export type ConnectionTab = 'projects' | 'reviews'

export function ConnectionTabBar({
  active,
  connectionId,
  onSelect,
}: {
  active: ConnectionTab
  connectionId: string
  onSelect: (tab: ConnectionTab) => void
}) {
  const insets = useSafeAreaInsets()
  const badge = useReviewsStore((s) => {
    const data = reviewsEntry(s, connectionId).data
    return data ? needsYouCount(data.prs, data.hidden, Date.now()) : 0
  })
  const tab = (id: ConnectionTab, label: string, icon: keyof typeof Ionicons.glyphMap) => {
    const on = id === active
    return (
      <Pressable
        key={id}
        style={styles.tab}
        onPress={() => !on && onSelect(id)}
        accessibilityRole="tab"
        accessibilityState={{ selected: on }}
        accessibilityLabel={id === 'reviews' && badge > 0 ? `${label}, ${badge} need you` : label}
        testID={`tab-${id}`}
      >
        <View>
          <Ionicons name={icon} size={22} color={on ? colors.accent : colors.textDim} />
          {id === 'reviews' && badge > 0 && (
            <View style={styles.badge} testID="reviews-badge">
              <Text style={styles.badgeText}>{badge > 99 ? '99+' : badge}</Text>
            </View>
          )}
        </View>
        <Text style={[styles.label, on && styles.labelOn]}>{label}</Text>
      </Pressable>
    )
  }
  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, space.sm) }]} accessibilityRole="tablist">
      {tab('projects', 'Projects', 'folder-outline')}
      {tab('reviews', 'Reviews', 'git-pull-request-outline')}
    </View>
  )
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: space.sm,
  },
  tab: { flex: 1, alignItems: 'center', gap: 2, minHeight: 44 },
  label: { fontFamily: fonts.display, fontSize: 11, color: colors.textDim },
  labelOn: { color: colors.accent },
  badge: {
    position: 'absolute',
    top: -4,
    right: -10,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 4,
    backgroundColor: colors.red,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: '#fff', fontSize: 10, fontFamily: fonts.displayBold },
})
