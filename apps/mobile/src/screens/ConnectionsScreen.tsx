/**
 * Home: Recents across every paired machine (components/HomeRecents), then the
 * machines as a glanceable status board rather than a list of settings.
 * Answers three questions without a tap - which machines are alive, which have
 * unread activity, and what each one actually is.
 *
 * "Machines" matches the desktop's own vocabulary (the machines table,
 * MachineChannels, MachineLayer); "backends" was a second name for the same
 * thing.
 *
 * Rows are cards (components/MachineRow) with a status dot, the transport and
 * the address, split into "Live" and "Needs attention". Machine-produced detail
 * (urls, zones, fingerprints) sits in the mono face; names in the display face.
 */
import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { Alert, FlatList, LayoutAnimation, Pressable, StyleSheet, Text, View } from 'react-native'
import { useFocusEffect, useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../../App'
import { colors, fonts, radius, space, type, HIT } from '../theme'
import { getSignedInEmail, warmUpGoogleAuth } from '../lib/google-auth'
import { initialsFromEmail } from '../lib/account'
import { BuildStamp } from '../components/BuildStamp'
import { confirmLeaveDemo } from '../components/DemoStrip'
import { Ionicons } from '@expo/vector-icons'
import { DEMO_CONNECTION_ID, DEMO_LABEL, DEMO_PROJECT } from '@shared/phone-demo/phone-demo'
import { chatCacheReady } from '../stores/chat'
import { useConnectionsStore, secretsReady, type ConnectionConfig } from '../stores/connections'
import { MachineRow } from '../components/MachineRow'
import { HomeRecents } from '../components/HomeRecents'
import { CERTIFICATE_CHANGED_MESSAGE, canPinCertificates } from '../lib/pinned-websocket'
import { transportRefusal } from '../lib/transport-gate'
import {
  CONNECTION_SECURITY_COPY,
  connectionSecurity,
  fillCopy,
  needsAttention,
  type ConnectionSecurity,
} from '@shared/connection-security'

type Nav = NativeStackNavigationProp<RootStackParamList, 'Connections'>

/** One-line target summary for either connection kind, in the mono face. */
function describeTarget(config: ConnectionConfig): string {
  return config.kind === 'iap'
    ? `${config.instance}  ${config.zone}`
    : config.url.replace(/^wss?:\/\//, '').replace(/\?.*$/, '')
}

function securityOf(config: ConnectionConfig, detail: string | undefined): ConnectionSecurity {
  return config.kind === 'iap'
    ? 'iap'
    : connectionSecurity({
        kind: 'ws',
        url: config.url,
        canPin: canPinCertificates,
        refused: typeof transportRefusal(config.url) === 'string',
        certificateChanged: detail === CERTIFICATE_CHANGED_MESSAGE,
      })
}

function confirmRemove(config: ConnectionConfig): void {
  Alert.alert('Remove machine?', `"${config.label}" will be forgotten on this device.`, [
    { text: 'Cancel', style: 'cancel' },
    {
      text: 'Remove',
      style: 'destructive',
      onPress: () => {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
        void useConnectionsStore.getState().removeConnection(config.id)
      },
    },
  ])
}

type ListItem =
  | { key: string; header: string; count?: string }
  | { key: string; config: ConnectionConfig; security: ConnectionSecurity }

export default function ConnectionsScreen() {
  const navigation = useNavigation<Nav>()
  const configs = useConnectionsStore((s) => s.configs)
  const status = useConnectionsStore((s) => s.status)
  const detail = useConnectionsStore((s) => s.detail)
  const demoActive = useConnectionsStore((s) => s.demoActive)
  const [ready, setReady] = useState(false)
  // Avatar monogram from the signed-in account rather than a hardcoded one.
  // Null until the keychain read resolves; the avatar shows a dash meanwhile.
  const [email, setEmail] = useState<string | null>(null)
  const initials = initialsFromEmail(email)

  useEffect(() => {
    let cancelled = false
    // Three things must land before the first dial: the Google token (IAP
    // configs cannot dial without it), the pairing tokens read back out of the
    // keystore, and the cached feeds. Dialling early would either present no
    // token and be rejected with 4001, or finish a fetch and seed a thread only
    // for the rehydrate to land after and replace it with the stale copy.
    void Promise.all([warmUpGoogleAuth(), secretsReady, chatCacheReady]).then(() => {
      if (cancelled) return
      const store = useConnectionsStore.getState()
      for (const config of store.configs) store.connect(config.id)
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
      setReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

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

  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: () => (
        <Pressable
          onPress={() => navigation.navigate('SignIn')}
          hitSlop={12}
          accessibilityLabel="Google account"
          style={({ pressed }) => [styles.headerAvatar, pressed && styles.pressed]}
        >
          <Text style={styles.headerAvatarText}>{initials}</Text>
        </Pressable>
      ),
      headerRight: () => (
        <Pressable
          onPress={() => navigation.navigate('Pair')}
          hitSlop={12}
          style={({ pressed }) => [styles.headerAction, pressed && styles.pressed]}
        >
          <Text style={styles.headerAdd}>+</Text>
        </Pressable>
      ),
    })
  }, [navigation, initials])

  const showRowActions = useCallback(
    (config: ConnectionConfig) => {
      const store = useConnectionsStore.getState()
      const current = store.status[config.id] ?? 'disconnected'
      const isLive = current === 'connected' || current === 'connecting'
      Alert.alert(config.label, describeTarget(config), [
        { text: 'Edit', onPress: () => navigation.navigate('Pair', { editId: config.id }) },
        {
          text: isLive ? 'Disconnect' : 'Connect',
          onPress: () => (isLive ? store.disconnect(config.id) : store.connect(config.id)),
        },
        { text: 'Remove', style: 'destructive', onPress: () => confirmRemove(config) },
        { text: 'Cancel', style: 'cancel' },
      ])
    },
    [navigation],
  )

  const openDemo = useCallback(() => {
    useConnectionsStore.getState().startDemo()
    navigation.navigate('Projects', { connectionId: DEMO_CONNECTION_ID, label: DEMO_LABEL })
    navigation.navigate('Conversations', {
      connectionId: DEMO_CONNECTION_ID,
      projectPath: DEMO_PROJECT.path,
      projectName: DEMO_PROJECT.name,
    })
  }, [navigation])

  if (configs.length === 0) {
    return (
      <View style={styles.emptyWrap}>
        <Text style={styles.emptyTitle}>Nothing paired yet</Text>
        <Text style={styles.emptyBody}>
          Start Switchboard on a machine, then scan the QR it prints. Everything it can reach shows up here.
        </Text>
        <View style={styles.emptyCode}>
          <Text style={styles.emptyCodeText}>npm run dev</Text>
          <Text style={styles.emptyCodeNote}>desktop app, shares its sessions</Text>
        </View>
        <View style={styles.emptyCode}>
          <Text style={styles.emptyCodeText}>npm run server</Text>
          <Text style={styles.emptyCodeNote}>headless, its own session pool</Text>
        </View>
        <Pressable
          onPress={() => navigation.navigate('Pair')}
          style={({ pressed }) => [styles.cta, pressed && styles.pressed]}
        >
          <Text style={styles.ctaText}>Scan a pairing QR</Text>
        </Pressable>
        <DemoEntry onOpen={openDemo} />
        {/* Also here, not only in Settings: a fresh install is exactly when
            someone asks which build they are holding, and it is the first
            place a pairing problem gets debugged. */}
        <BuildStamp />
      </View>
    )
  }

  const liveCount = configs.filter((c) => (status[c.id] ?? 'disconnected') === 'connected').length
  const rows = configs.map((config) => ({ key: config.id, config, security: securityOf(config, detail[config.id]) }))
  const attention = rows.filter((row) => needsAttention(row.security, status[row.key] ?? 'disconnected'))
  const items: ListItem[] = [
    {
      key: 'h-live',
      header: CONNECTION_SECURITY_COPY.sectionLive,
      count: ready ? fillCopy('liveCount', { live: liveCount, total: configs.length }) : 'connecting',
    },
    ...rows.filter((row) => !attention.includes(row)),
    ...(attention.length > 0 ? [{ key: 'h-attention', header: CONNECTION_SECURITY_COPY.sectionAttention }] : []),
    ...attention,
  ]

  return (
    <FlatList
      data={items}
      keyExtractor={(item) => item.key}
      contentContainerStyle={styles.list}
      ListHeaderComponent={
        <HomeRecents
          onOpen={(row) =>
            navigation.navigate('Thread', {
              connectionId: row.connectionId,
              threadId: row.id,
              title: row.title,
              projectPath: row.projectPath,
              worktreePath: row.worktreePath ?? null,
              worktreeBranch: row.worktreeBranch ?? undefined,
            })
          }
        />
      }
      ListFooterComponent={
        <View>
          {demoActive && <DemoEntry onOpen={openDemo} />}
          <Pressable
            onPress={() => navigation.navigate('Settings')}
            testID="open-settings"
            accessibilityRole="button"
            style={({ pressed }) => [styles.settingsLink, pressed && styles.pressed]}
          >
            <Ionicons name="settings-outline" size={16} color={colors.textDim} />
            <Text style={styles.settingsLinkText}>Settings</Text>
          </Pressable>
          {__DEV__ && (
            <Pressable onPress={() => navigation.navigate('DevGallery')} style={styles.devLink}>
              <Text style={styles.devLinkText}>Component gallery</Text>
            </Pressable>
          )}
        </View>
      }
      renderItem={({ item }) =>
        'header' in item ? (
          <View style={styles.listHeader}>
            <Text style={styles.overline}>{item.header}</Text>
            {item.count ? <Text style={styles.count}>{item.count}</Text> : null}
          </View>
        ) : (
          <MachineRow
            config={item.config}
            security={item.security}
            status={status[item.key] ?? 'disconnected'}
            detail={detail[item.key]}
            onOpen={() => navigation.navigate('Projects', { connectionId: item.key, label: item.config.label })}
            onActions={() => showRowActions(item.config)}
            onScan={() => navigation.navigate('Pair', { editId: item.key, rescan: true })}
            onUseIap={() => navigation.navigate('Pair', { kind: 'iap' })}
            onRemove={() => confirmRemove(item.config)}
          />
        )
      }
    />
  )
}

const styles = StyleSheet.create({
  devLink: { alignItems: 'center', paddingVertical: space.sm },
  settingsLink: {
    minHeight: HIT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    marginTop: space.lg,
  },
  settingsLinkText: { color: colors.textDim, ...type.bodySm },
  devLinkText: { color: colors.textFaint, ...type.monoSm },
  list: {
    paddingHorizontal: space.lg,
    paddingBottom: space.xxl,
  },
  listHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingTop: space.md,
    paddingBottom: 6,
    paddingHorizontal: 2,
  },
  overline: {
    ...type.label,
    color: colors.textDim,
    textTransform: 'uppercase',
  },
  count: {
    ...type.monoSm,
    color: colors.textDim,
  },

  headerAction: {
    minHeight: HIT,
    justifyContent: 'center',
    paddingHorizontal: space.xs,
  },
  // An avatar chip rather than blue link text: it stopped competing with the
  // title and stopped looking like a second, differently-styled action.
  headerAvatar: {
    width: 30,
    height: 30,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
    // On Android the native header lays the title immediately after headerLeft,
    // so without this the title crowds the avatar. headerRight gets the same
    // breathing room from headerAction's paddingHorizontal.
    marginRight: space.sm,
  },
  headerAvatarText: {
    fontFamily: fonts.display,
    fontSize: 11,
    color: colors.textDim,
    letterSpacing: 0.5,
  },
  headerAdd: {
    color: colors.accent,
    fontSize: 27,
    lineHeight: 31,
    fontWeight: '300',
  },
  pressed: {
    opacity: 0.55,
  },

  emptyWrap: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: space.xl,
  },
  emptyTitle: {
    ...type.title,
    color: colors.text,
    marginBottom: space.sm,
  },
  emptyBody: {
    ...type.body,
    color: colors.textDim,
    marginBottom: space.xl,
  },
  emptyCode: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    marginBottom: space.sm,
  },
  emptyCodeText: {
    ...type.mono,
    color: colors.accent,
  },
  emptyCodeNote: {
    ...type.monoSm,
    color: colors.textFaint,
    marginTop: 2,
  },
  cta: {
    marginTop: space.lg,
    minHeight: HIT + 4,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  demoButton: {
    marginTop: space.sm,
    minHeight: HIT + 4,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    flexDirection: 'row',
    gap: space.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  demoButtonText: { fontFamily: fonts.display, fontSize: 15, color: colors.text },
  demoNote: { ...type.bodySm, color: colors.textFaint, textAlign: 'center', marginTop: space.sm },
  demoLeave: { alignItems: 'center', paddingVertical: space.sm },
  demoLeaveText: { fontFamily: fonts.display, fontSize: 14, color: colors.purple },
  ctaText: {
    fontFamily: fonts.display,
    fontSize: 15,
    color: '#08131f',
  },
})

/**
 * "Try the demo" on the empty screen. While the demo is open it reads "Back to
 * the demo" and offers Leave demo, here, in the list footer and in Settings,
 * not only in the demo's own strip.
 */
function DemoEntry({ onOpen }: { onOpen: () => void }) {
  const active = useConnectionsStore((s) => s.demoActive)
  return (
    <View>
      <Pressable
        onPress={onOpen}
        testID="try-demo"
        accessibilityRole="button"
        style={({ pressed }) => [styles.demoButton, pressed && styles.pressed]}
      >
        <Ionicons name="play-circle-outline" size={18} color={colors.purple} />
        <Text style={styles.demoButtonText}>{active ? 'Back to the demo' : 'Try the demo'}</Text>
      </Pressable>
      {active ? (
        <Pressable
          onPress={() => confirmLeaveDemo(() => undefined)}
          testID="settings-leave-demo"
          accessibilityRole="button"
          hitSlop={8}
          style={({ pressed }) => [styles.demoLeave, pressed && styles.pressed]}
        >
          <Text style={styles.demoLeaveText}>Leave demo</Text>
        </Pressable>
      ) : (
        <Text style={styles.demoNote}>
          Sample chats and pull requests on this phone. No machine needed, nothing is sent anywhere.
        </Text>
      )}
    </View>
  )
}
