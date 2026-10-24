import { Pressable, StyleSheet } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { colors, space, HIT } from '../theme'

/** Header button that opens message search, on the Projects and chat list screens as on Android. */
export function MessageSearchButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      hitSlop={12}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Search messages"
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      <Ionicons name="search" size={20} color={colors.accent} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  button: { minHeight: HIT, justifyContent: 'center', paddingHorizontal: space.xs },
  pressed: { opacity: 0.55 },
})
