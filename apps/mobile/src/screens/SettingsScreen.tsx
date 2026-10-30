/**
 * App settings, also reached by the switchboard://settings link. Same sections
 * as Android's Settings screen; machines are the home screen under this one.
 */
import { useCallback, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native'
import { useFocusEffect, useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import type { TurnDelivery } from '@shared/turn-delivery'
import { PHONE_HTML_LIVE_FLAG } from '@shared/html-live-phone'
import type { RootStackParamList } from '../../App'
import { colors, fonts, radius, space, type, HIT } from '../theme'
import { getSignedInEmail } from '../lib/google-auth'
import { BuildStamp } from '../components/BuildStamp'
import { confirmLeaveDemo } from '../components/DemoStrip'
import { usePrefsStore } from '../stores/prefs'
import { useConnectionsStore } from '../stores/connections'

type Nav = NativeStackNavigationProp<RootStackParamList, 'Settings'>

export default function SettingsScreen() {
  const navigation = useNavigation<Nav>()
  const demoActive = useConnectionsStore((s) => s.demoActive)
  const paired = useConnectionsStore((s) => s.configs.length)
  const live = useConnectionsStore((s) => s.configs.filter((c) => s.status[c.id] === 'connected').length)
  const [email, setEmail] = useState<string | null>(null)

  // Re-read on focus: signing in or out happens on another screen.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false
      void getSignedInEmail().then((value) => {
        if (!cancelled) setEmail(value)
      })
      return () => {
        cancelled = true
      }
    }, []),
  )

  return (
    <ScrollView contentContainerStyle={styles.list}>
      {demoActive && (
        <>
          <Text style={styles.overline}>Demo</Text>
          <Pressable
            onPress={() => confirmLeaveDemo(() => navigation.popToTop())}
            testID="settings-leave-demo"
            accessibilityRole="button"
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          >
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle}>Leave demo</Text>
              <Text style={styles.rowDetail}>Sample data on this phone. Leaving keeps nothing.</Text>
            </View>
          </Pressable>
        </>
      )}

      <Text style={styles.overline}>Account</Text>
      <Pressable
        onPress={() => navigation.navigate('SignIn')}
        testID="settings-google-account"
        accessibilityRole="button"
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      >
        <View style={styles.rowBody}>
          <Text style={styles.rowTitle}>Google account</Text>
          <Text style={styles.rowDetail}>{email ?? 'Not connected'}</Text>
        </View>
        <Text style={styles.rowAction}>Open</Text>
      </Pressable>

      <Text style={styles.overline}>Connections</Text>
      <Pressable
        onPress={() => navigation.popToTop()}
        testID="settings-machines"
        accessibilityRole="button"
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      >
        <View style={styles.rowBody}>
          <Text style={styles.rowTitle}>Machines</Text>
          <Text style={styles.rowDetail}>{paired === 0 ? 'No machines paired' : `${live} of ${paired} live`}</Text>
        </View>
        <Text style={styles.rowAction}>Open</Text>
      </Pressable>

      <Text style={styles.overline}>Chat</Text>
      <FollowUpDefaultSetting />
      <LiveHtmlPagesSetting />

      <Text style={styles.overline}>App</Text>
      <BuildStamp />
    </ScrollView>
  )
}

/**
 * This device's "Follow-up while the agent works": what a send does while a
 * turn runs. The composer's chip flips it for one send.
 */
function FollowUpDefaultSetting() {
  const value = usePrefsStore((s) => s.followUpDefault)
  const setValue = usePrefsStore((s) => s.setFollowUpDefault)
  const options: Array<{ value: TurnDelivery; label: string }> = [
    { value: 'steer', label: 'Steer' },
    { value: 'queue', label: 'Queue' },
  ]
  return (
    <View style={styles.followUp}>
      <Text style={styles.rowTitle}>Follow-up while the agent works</Text>
      <View style={styles.followUpOptions} accessibilityRole="radiogroup">
        {options.map((option) => {
          const on = option.value === value
          return (
            <Pressable
              key={option.value}
              onPress={() => setValue(option.value)}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              testID={`follow-up-${option.value}`}
              style={[styles.followUpOption, on && styles.followUpOptionOn]}
            >
              <Text style={[styles.followUpOptionText, on && styles.followUpOptionTextOn]}>{option.label}</Text>
            </Pressable>
          )
        })}
      </View>
    </View>
  )
}

/** The `phone_html_live_run` flag: off by default, nothing turns it on for the user. */
function LiveHtmlPagesSetting() {
  const value = usePrefsStore((s) => s.liveHtmlPages)
  const setValue = usePrefsStore((s) => s.setLiveHtmlPages)
  return (
    <View style={styles.row}>
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle}>Run live pages</Text>
        <Text style={styles.rowDetail}>
          Experimental. Runs a live page from the agent on this phone, with no network.
        </Text>
      </View>
      <Switch
        value={value}
        onValueChange={setValue}
        testID={`settings-${PHONE_HTML_LIVE_FLAG}`}
        accessibilityLabel="Run live pages"
        trackColor={{ true: colors.accent }}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: space.lg, paddingBottom: space.xxl },
  overline: {
    ...type.label,
    color: colors.textDim,
    textTransform: 'uppercase',
    paddingTop: space.lg,
    paddingBottom: 6,
    paddingHorizontal: 2,
  },
  row: {
    minHeight: HIT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
  },
  rowBody: { flex: 1, gap: 2 },
  rowTitle: { ...type.body, color: colors.text },
  rowDetail: { ...type.bodySm, color: colors.textDim },
  rowAction: { fontFamily: fonts.display, fontSize: 14, color: colors.accent },
  pressed: { opacity: 0.55 },
  followUp: { paddingVertical: space.sm, gap: space.sm },
  followUpOptions: { flexDirection: 'row', gap: space.sm },
  followUpOption: {
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  followUpOptionOn: { borderColor: colors.accent, backgroundColor: colors.accentWash },
  followUpOptionText: { color: colors.textDim, ...type.bodySm },
  followUpOptionTextOn: { color: colors.accent },
})
