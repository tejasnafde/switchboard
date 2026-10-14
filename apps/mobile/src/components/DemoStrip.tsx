/**
 * The demo's marks: a purple strip with "Leave demo" at the top of every demo
 * screen, and a DEMO badge next to the demo machine's name.
 */
import type { ComponentType } from 'react'
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { NOT_IN_DEMO, isDemoConnection } from '@shared/phone-demo/phone-demo'
import { leaveDemo } from '../lib/demo'
import { colors, fonts, radius, space, type } from '../theme'

const STRIP_HEIGHT = 36
/** Space the strip takes, so a screen that offsets for the keyboard can add it to its header height. */
export const DEMO_STRIP_HEIGHT = STRIP_HEIGHT + space.xs

/** Ask, then leave the demo and run `onLeft` (back to the empty Connections screen). */
export function confirmLeaveDemo(onLeft: () => void): void {
  Alert.alert(
    'Leave the demo?',
    'You go back to the empty Connections screen. Nothing from the demo is kept, and you can open it again any time.',
    [
      { text: 'Stay', style: 'cancel' },
      {
        text: 'Leave demo',
        style: 'destructive',
        onPress: () => {
          leaveDemo()
          onLeft()
        },
      },
    ],
  )
}

export function DemoStrip({ onLeft }: { onLeft: () => void }) {
  return (
    <View style={styles.strip} testID="demo-strip">
      <Ionicons name="cloud-offline-outline" size={14} color={colors.purple} />
      <Text style={styles.text} numberOfLines={1}>
        <Text style={styles.strong}>Demo</Text> · sample data, offline
      </Text>
      <Pressable
        onPress={() => confirmLeaveDemo(onLeft)}
        hitSlop={10}
        accessibilityRole="button"
        testID="demo-leave"
        style={({ pressed }) => pressed && styles.pressed}
      >
        <Text style={styles.leave}>Leave demo</Text>
      </Pressable>
    </View>
  )
}

export function DemoBadge() {
  return <Text style={styles.badge}>DEMO</Text>
}

interface DemoScreenProps {
  route: { params?: object }
  navigation: { reset: (state: { index: number; routes: Array<{ name: 'Connections' }> }) => void }
}

/**
 * Wrap a screen so it carries the strip whenever its connection is the demo.
 * `notInDemo` replaces the screen with a note, for flows the demo cannot run.
 */
export function withDemoStrip<P extends DemoScreenProps>(
  Screen: ComponentType<P>,
  { notInDemo = false }: { notInDemo?: boolean } = {},
): ComponentType<P> {
  function DemoAwareScreen(props: P) {
    const params = props.route.params as { connectionId?: string } | undefined
    if (!isDemoConnection(params?.connectionId)) return <Screen {...props} />
    return (
      <View style={styles.screen}>
        <DemoStrip onLeft={() => props.navigation.reset({ index: 0, routes: [{ name: 'Connections' }] })} />
        {notInDemo ? <Text style={styles.notInDemo}>{NOT_IN_DEMO}</Text> : <Screen {...props} />}
      </View>
    )
  }
  DemoAwareScreen.displayName = `withDemoStrip(${Screen.displayName ?? Screen.name})`
  return DemoAwareScreen
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  strip: {
    height: STRIP_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    marginHorizontal: space.md,
    marginTop: space.xs,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.purple,
    backgroundColor: colors.purpleWash,
  },
  text: { ...type.bodySm, color: colors.textDim, flex: 1 },
  strong: { fontFamily: fonts.display, color: colors.purple },
  leave: { fontFamily: fonts.display, fontSize: 13, color: colors.purple },
  pressed: { opacity: 0.55 },
  notInDemo: { ...type.body, color: colors.textDim, textAlign: 'center', padding: space.xl },
  badge: {
    ...type.label,
    color: colors.purple,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.purple,
    backgroundColor: colors.purpleWash,
    borderRadius: radius.sm,
    paddingHorizontal: 5,
    paddingVertical: 1,
    overflow: 'hidden',
  },
})
