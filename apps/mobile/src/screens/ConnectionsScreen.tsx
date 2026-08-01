/**
 * Machines: the app's home, and a glanceable status board rather than a list of
 * settings. Answers three questions without a tap - which machines are alive,
 * which have unread activity, and what each one actually is.
 *
 * "Machines" matches the desktop's own vocabulary (the machines table,
 * MachineChannels, MachineLayer); "backends" was a second name for the same
 * thing.
 *
 * Rows are cards with a status rail down the left edge, coloured by liveness, so
 * state reads peripherally without a legend. Machine-produced detail (urls,
 * instance names) sits in the mono face; names sit in the display face.
 */
import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  FlatList,
  LayoutAnimation,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useFocusEffect, useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../../App'
import { colors, fonts, radius, space, statusColor, type, HIT } from '../theme'
import { getSignedInEmail, warmUpGoogleAuth } from '../lib/google-auth'
import { initialsFromEmail } from '../lib/account'
import { BuildStamp } from '../components/BuildStamp'
import { useConnectionsStore, type ConnectionConfig, type ConnectionStatus } from '../stores/connections'

type Nav = NativeStackNavigationProp<RootStackParamList, 'Connections'>

/** One-line target summary for either connection kind, in the mono face. */
function describeTarget(config: ConnectionConfig): string {
  return config.kind === 'iap'
    ? `${config.instance}  ${config.zone}`
    : config.url.replace(/^wss?:\/\//, '')
}

const STATUS_COPY: Record<ConnectionStatus, string> = {
  connected: 'live',
  connecting: 'connecting',
  disconnected: 'offline',
  error: 'error',
}

function ConnectionRow({
  config,
  status,
  detail,
  onOpen,
  onActions,
}: {
  config: ConnectionConfig
  status: ConnectionStatus
  detail?: string
  onOpen: () => void
  onActions: () => void
}) {
  const tint = statusColor[status] ?? colors.textFaint
  const live = status === 'connected'
  return (
    <Pressable
      onPress={onOpen}
      onLongPress={onActions}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
    >
      {/* Status rail: liveness readable peripherally, no legend needed. */}
      <View style={[styles.rail, { backgroundColor: tint }]} />
      <View style={styles.cardBody}>
        <View style={styles.cardTop}>
          <Text style={styles.cardName} numberOfLines={1}>
            {config.label}
          </Text>
          {config.kind === 'iap' && <Text style={styles.kindTag}>IAP</Text>}
        </View>
        <Text style={styles.cardTarget} numberOfLines={1}>
          {describeTarget(config)}
        </Text>
        <View style={styles.cardFoot}>
          {status === 'connecting' ? (
            <ActivityIndicator size="small" color={tint} />
          ) : (
            <View style={[styles.dot, { backgroundColor: tint }]} />
          )}
          <Text style={[styles.statusText, live && { color: colors.textDim }]}>
            {STATUS_COPY[status]}
          </Text>
          {/* Says WHY when it is not live: a socket that opens and is dropped
              reads the same as one that never opens without this. */}
          {!live && detail ? <Text style={styles.statusDetail}>{detail}</Text> : null}
        </View>
      </View>
    </Pressable>
  )
}

export default function ConnectionsScreen() {
  const navigation = useNavigation<Nav>()
  const configs = useConnectionsStore((s) => s.configs)
  const status = useConnectionsStore((s) => s.status)
  const detail = useConnectionsStore((s) => s.detail)
  const [ready, setReady] = useState(false)
  // Avatar monogram from the signed-in account rather than a hardcoded one.
  // Null until the keychain read resolves; the avatar shows a dash meanwhile.
  const [email, setEmail] = useState<string | null>(null)
  const initials = initialsFromEmail(email)

  useEffect(() => {
    let cancelled = false
    // IAP configs need a Google token in hand before dialling, so wait for the
    // silent refresh. ws:// configs do not care, and the wait is a no-op once
    // the keychain read is cached.
    void warmUpGoogleAuth().then(() => {
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
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () =>
            Alert.alert('Remove machine?', `"${config.label}" will be forgotten on this device.`, [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Remove',
                style: 'destructive',
                onPress: () => {
                  LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
                  useConnectionsStore.getState().removeConnection(config.id)
                },
              },
            ]),
        },
        { text: 'Cancel', style: 'cancel' },
      ])
    },
    [navigation],
  )

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
      </View>
    )
  }

  const liveCount = configs.filter((c) => (status[c.id] ?? 'disconnected') === 'connected').length

  return (
    <FlatList
      data={configs}
      keyExtractor={(item) => item.id}
      contentContainerStyle={styles.list}
      ListHeaderComponent={
        <View style={styles.listHeader}>
          <Text style={styles.overline}>MACHINES</Text>
          <Text style={styles.count}>
            {ready ? `${liveCount} of ${configs.length} live` : 'connecting'}
          </Text>
        </View>
      }
      ListFooterComponent={
        <View>
          <BuildStamp />
          {__DEV__ && (
            <Pressable onPress={() => navigation.navigate('DevGallery')} style={styles.devLink}>
              <Text style={styles.devLinkText}>Component gallery</Text>
            </Pressable>
          )}
        </View>
      }
      renderItem={({ item }) => (
        <ConnectionRow
          config={item}
          status={status[item.id] ?? 'disconnected'}
          detail={detail[item.id]}
          onOpen={() => navigation.navigate('Projects', { connectionId: item.id, label: item.label })}
          onActions={() => showRowActions(item)}
        />
      )}
    />
  )
}

const styles = StyleSheet.create({
  devLink: { alignItems: 'center', paddingVertical: space.sm },
  devLinkText: { color: colors.textFaint, ...type.monoSm },
  list: {
    paddingHorizontal: space.lg,
    paddingBottom: space.xxl,
  },
  listHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingTop: space.lg,
    paddingBottom: space.md,
  },
  overline: {
    ...type.label,
    color: colors.textFaint,
    textTransform: 'uppercase',
  },
  count: {
    ...type.monoSm,
    color: colors.textFaint,
  },

  card: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    marginBottom: space.md,
    overflow: 'hidden',
    minHeight: 78,
  },
  cardPressed: {
    backgroundColor: colors.surfaceRaised,
  },
  rail: {
    width: 3,
  },
  cardBody: {
    flex: 1,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    gap: 3,
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  cardName: {
    ...type.heading,
    color: colors.text,
    flexShrink: 1,
  },
  kindTag: {
    ...type.monoSm,
    color: colors.accent,
    backgroundColor: colors.accentWash,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  cardTarget: {
    ...type.mono,
    color: colors.textDim,
  },
  cardFoot: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginTop: space.xs,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: radius.pill,
  },
  statusDetail: { color: colors.textFaint, ...type.monoSm },
  statusText: {
    ...type.monoSm,
    color: colors.textFaint,
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
  ctaText: {
    fontFamily: fonts.display,
    fontSize: 15,
    color: '#08131f',
  },
})
