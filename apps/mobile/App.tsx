import { useEffect } from 'react'
import { StyleSheet, View } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { NavigationContainer, DarkTheme, createNavigationContainerRef } from '@react-navigation/native'
import * as Notifications from 'expo-notifications'
import { initPushWhenPaired } from './src/stores/push'
import { threadRouteFromPush, type ThreadRoute } from './src/lib/push-route'
import DevGalleryScreen from './src/screens/DevGalleryScreen'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { StatusBar } from 'expo-status-bar'
import { useFonts } from 'expo-font'
import { InstrumentSans_600SemiBold, InstrumentSans_700Bold } from '@expo-google-fonts/instrument-sans'
import { GeistMono_400Regular, GeistMono_500Medium } from '@expo-google-fonts/geist-mono'
import { createLogger } from '@shared/logger'
import { colors, fonts } from './src/theme'
import { getCachedAccessToken, warmUpGoogleAuth } from './src/lib/google-auth'
import { installLifecycleReconnect, installNetworkWatch, setGoogleTokenProvider } from './src/stores/connections'
import { hydrateOutbox } from './src/stores/outbox'
import { UpdateBanner } from './src/components/UpdateBanner'
import ConnectionsScreen from './src/screens/ConnectionsScreen'
import PairScreen from './src/screens/PairScreen'
import ProjectsScreen from './src/screens/ProjectsScreen'
import ConversationsScreen from './src/screens/ConversationsScreen'
import ThreadScreen from './src/screens/ThreadScreen'
import NewSessionScreen from './src/screens/NewSessionScreen'
import ReviewsScreen from './src/screens/ReviewsScreen'
import PullRequestScreen from './src/screens/PullRequestScreen'
import type { PrDetail, PrRef } from '@shared/pull-requests'
import SignInScreen from './src/screens/SignInScreen'
import { DemoBadge, withDemoStrip } from './src/components/DemoStrip'
import { isDemoConnection } from '@shared/phone-demo/phone-demo'

const log = createLogger('app')

export type RootStackParamList = {
  Connections: undefined
  SignIn: undefined
  Pair: { editId?: string } | undefined
  /** `viaTab`: reached from the Reviews tab, so it swaps in without a push animation. */
  Projects: { connectionId: string; label: string; viaTab?: boolean }
  Conversations: { connectionId: string; projectPath: string; projectName: string }
  Thread: {
    connectionId: string
    threadId: string
    title: string
    projectPath: string
    worktreePath?: string | null
    worktreeBranch?: string
    worktreeId?: string
    creationId?: string
    isNew?: boolean
  }
  NewSession: {
    connectionId: string
    projectPath: string
    projectName: string
    /** "Work on PR": start the chat on this pull request's branch, linked, with a review pill. */
    pullRequest?: PrDetail
  }
  Reviews: { connectionId: string; label: string }
  PullRequest: { connectionId: string; ref: PrRef; title: string }
  DevGallery: undefined
}

const Stack = createNativeStackNavigator<RootStackParamList>()

// Every screen under a connection carries the demo strip when that connection
// is the demo. A new chat needs a real machine.
const DemoProjectsScreen = withDemoStrip(ProjectsScreen)
const DemoReviewsScreen = withDemoStrip(ReviewsScreen)
const DemoPullRequestScreen = withDemoStrip(PullRequestScreen)
const DemoConversationsScreen = withDemoStrip(ConversationsScreen)
const DemoThreadScreen = withDemoStrip(ThreadScreen)
const DemoNewSessionScreen = withDemoStrip(NewSessionScreen, { notInDemo: true })

/** The DEMO badge in the header of the demo's own machine screens. */
function demoBadge(connectionId: string) {
  return isDemoConnection(connectionId) ? { headerRight: () => <DemoBadge /> } : {}
}

const theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.bg,
    card: colors.surface,
    border: colors.border,
    text: colors.text,
    primary: colors.accent,
  },
}

// The connections store dials IAP inside a synchronous action, so it gets a
// sync getter over the cached token instead of a promise. Registered before the
// navigator mounts, since ConnectionsScreen connects on its first render.
setGoogleTokenProvider(getCachedAccessToken)

/**
 * Foreground presentation. Without this a notification arriving while the app
 * is open is delivered to the handler and never shown.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
})

export const navigationRef = createNavigationContainerRef<RootStackParamList>()

/**
 * A tap can arrive before the navigation container mounts, which is normal on a
 * cold start. Dropping it - as an isReady() guard did - lost exactly the taps
 * that matter most, so the target waits here and `onReady` flushes it.
 */
let pendingRoute: ThreadRoute | null = null

function openFromPush(data: unknown): void {
  const route = threadRouteFromPush(data)
  if (!route) {
    log.warn('notification payload could not address a thread', data)
    return
  }
  if (!navigationRef.isReady()) {
    pendingRoute = route
    return
  }
  navigationRef.navigate('Thread', route)
}

function flushPendingRoute(): void {
  const route = pendingRoute
  pendingRoute = null
  if (route && navigationRef.isReady()) navigationRef.navigate('Thread', route)
}

export default function App() {
  // Display grotesque + technical mono. Names must match src/theme.ts `fonts`.
  const [fontsLoaded] = useFonts({
    InstrumentSans_600SemiBold,
    InstrumentSans_700Bold,
    GeistMono_400Regular,
    GeistMono_500Medium,
  })

  useEffect(() => {
    // Silent refresh on start: hydrates the keychain and renews the token if it
    // is close to expiry, so the first IAP dial does not have to wait.
    void warmUpGoogleAuth().catch((err) => log.warn('google auth warm-up failed', err))
    // Anything the user sent before the app was last killed is still owed to
    // them. Restored before the first dial so it goes out as soon as a backend
    // answers.
    void hydrateOutbox()
  }, [])

  // The OS suspends sockets without closing them, so a returning user would
  // otherwise see a live-looking screen backed by a dead connection until an
  // invoke times out. Installed once, for every connection.
  useEffect(() => installLifecycleReconnect(), [])
  useEffect(() => installNetworkWatch(), [])
  useEffect(() => initPushWhenPaired(), [])

  // Tapping a notification opens the thread it came from.
  //
  // Two paths, and only the first was handled before. The listener covers a tap
  // while the app is alive. A tap that LAUNCHES a killed app delivers its
  // response before any listener attaches, so the initial response has to be
  // read separately - that is the common case for a notification, since the
  // point of one is that the app is not open.
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      openFromPush(response.notification.request.content.data)
    })
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) openFromPush(response.notification.request.content.data)
    })
    return () => sub.remove()
  }, [])

  // Hold the first paint until the faces are in memory. Rendering early would
  // lay text out in the system face and reflow it, which is more jarring than a
  // brief hold. Painted in the app background so there is no white flash.
  if (!fontsLoaded) return <View style={{ flex: 1, backgroundColor: colors.bg }} />

  return (
    // The update banners sit OUTSIDE NavigationContainer so they overlay every
    // screen and are not torn down by navigation. They drive both update lanes:
    // OTA for JS-only changes, a GitHub-released APK for native ones.
    // Android edge-to-edge is unconditional from SDK 57, so the gesture bar
    // overlays the app and nothing pads for it unless this provider is mounted.
    <SafeAreaProvider style={styles.root}>
      <NavigationContainer theme={theme} ref={navigationRef} onReady={flushPendingRoute}>
        <StatusBar style="light" />
        <Stack.Navigator
          initialRouteName="Connections"
          screenOptions={{
            headerStyle: { backgroundColor: colors.surface },
            headerTintColor: colors.text,
            contentStyle: { backgroundColor: colors.bg },
          }}
        >
          <Stack.Screen name="Connections" component={ConnectionsScreen} options={{ title: 'Switchboard' }} />
          <Stack.Screen
            name="SignIn"
            component={SignInScreen}
            options={{ title: 'Google account', presentation: 'modal' }}
          />
          <Stack.Screen name="Pair" component={PairScreen} options={{ title: 'Pair backend', presentation: 'modal' }} />
          <Stack.Screen
            name="Projects"
            component={DemoProjectsScreen}
            options={({ route }) => ({
              title: route.params.label,
              animation: route.params.viaTab ? 'none' : 'default',
              ...demoBadge(route.params.connectionId),
            })}
          />
          <Stack.Screen
            name="Reviews"
            component={DemoReviewsScreen}
            options={({ route }) => ({ title: 'Reviews', animation: 'none', ...demoBadge(route.params.connectionId) })}
          />
          <Stack.Screen
            name="PullRequest"
            component={DemoPullRequestScreen}
            options={{ title: 'Pull request', headerBackTitle: 'Reviews' }}
          />
          <Stack.Screen
            name="Conversations"
            component={DemoConversationsScreen}
            options={({ route }) => ({ title: route.params.projectName })}
          />
          <Stack.Screen
            name="Thread"
            component={DemoThreadScreen}
            options={({ route }) => ({ title: route.params.title })}
          />
          <Stack.Screen
            name="NewSession"
            component={DemoNewSessionScreen}
            options={{ title: 'New session', presentation: 'modal' }}
          />
          {__DEV__ && (
            <Stack.Screen name="DevGallery" component={DevGalleryScreen} options={{ title: 'Component gallery' }} />
          )}
        </Stack.Navigator>
      </NavigationContainer>
      <UpdateBanner />
    </SafeAreaProvider>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
})
