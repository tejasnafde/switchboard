import { useEffect } from 'react'
import { StyleSheet, View } from 'react-native'
import { NavigationContainer, DarkTheme, createNavigationContainerRef } from '@react-navigation/native'
import * as Notifications from 'expo-notifications'
import { usePushStore } from './src/stores/push'
import { threadRouteFromPush, type ThreadRoute } from './src/lib/pushRoute'
import DevGalleryScreen from './src/screens/DevGalleryScreen'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { StatusBar } from 'expo-status-bar'
import { useFonts } from 'expo-font'
import {
  InstrumentSans_600SemiBold,
  InstrumentSans_700Bold,
} from '@expo-google-fonts/instrument-sans'
import { GeistMono_400Regular, GeistMono_500Medium } from '@expo-google-fonts/geist-mono'
import { createLogger } from '@shared/logger'
import { colors, fonts } from './src/theme'
import { getCachedAccessToken, warmUpGoogleAuth } from './src/lib/google-auth'
import { installLifecycleReconnect, setGoogleTokenProvider } from './src/stores/connections'
import { hydrateOutbox } from './src/stores/outbox'
import { UpdateBanner } from './src/components/UpdateBanner'
import ConnectionsScreen from './src/screens/ConnectionsScreen'
import PairScreen from './src/screens/PairScreen'
import ProjectsScreen from './src/screens/ProjectsScreen'
import ConversationsScreen from './src/screens/ConversationsScreen'
import ThreadScreen from './src/screens/ThreadScreen'
import NewSessionScreen from './src/screens/NewSessionScreen'
import SignInScreen from './src/screens/SignInScreen'

const log = createLogger('app')

export type RootStackParamList = {
  Connections: undefined
  SignIn: undefined
  Pair: { editId?: string } | undefined
  Projects: { connectionId: string; label: string }
  Conversations: { connectionId: string; projectPath: string; projectName: string }
  Thread: { connectionId: string; threadId: string; title: string; projectPath: string; isNew?: boolean }
  NewSession: { connectionId: string; projectPath: string; projectName: string }
  DevGallery: undefined
}

const Stack = createNativeStackNavigator<RootStackParamList>()

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
    void usePushStore.getState().init()
    // Anything the user sent before the app was last killed is still owed to
    // them. Restored before the first dial so it goes out as soon as a backend
    // answers.
    void hydrateOutbox()
  }, [])

  // The OS suspends sockets without closing them, so a returning user would
  // otherwise see a live-looking screen backed by a dead connection until an
  // invoke times out. Installed once, for every connection.
  useEffect(() => installLifecycleReconnect(), [])

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
    <View style={styles.root}>
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
            component={ProjectsScreen}
            options={({ route }) => ({ title: route.params.label })}
          />
          <Stack.Screen
            name="Conversations"
            component={ConversationsScreen}
            options={({ route }) => ({ title: route.params.projectName })}
          />
          <Stack.Screen name="Thread" component={ThreadScreen} options={({ route }) => ({ title: route.params.title })} />
          <Stack.Screen
            name="NewSession"
            component={NewSessionScreen}
            options={{ title: 'New session', presentation: 'modal' }}
          />
          {__DEV__ && (
            <Stack.Screen
              name="DevGallery"
              component={DevGalleryScreen}
              options={{ title: 'Component gallery' }}
            />
          )}
        </Stack.Navigator>
      </NavigationContainer>
      <UpdateBanner />
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
})
