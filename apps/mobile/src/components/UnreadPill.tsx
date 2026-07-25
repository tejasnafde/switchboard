/** Accent unread-count badge shared by the project and conversation lists. */
import { StyleSheet, Text, View } from 'react-native'
import { colors } from '../theme'

export function UnreadPill({ count }: { count: number }) {
  if (count === 0) return null
  return (
    <View style={styles.pill}>
      <Text style={styles.text}>{count > 99 ? '99+' : count}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  pill: {
    minWidth: 20,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 10,
    backgroundColor: colors.accent,
    alignItems: 'center',
  },
  text: {
    color: colors.bg,
    fontSize: 11,
    fontWeight: '700',
  },
})
