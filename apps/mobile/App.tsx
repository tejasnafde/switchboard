import { NavigationContainer, DarkTheme } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { StatusBar } from 'expo-status-bar'
import { colors } from './src/theme'
import ConnectionsScreen from './src/screens/ConnectionsScreen'
import PairScreen from './src/screens/PairScreen'
import ProjectsScreen from './src/screens/ProjectsScreen'
import ConversationsScreen from './src/screens/ConversationsScreen'
import ThreadScreen from './src/screens/ThreadScreen'
import NewSessionScreen from './src/screens/NewSessionScreen'

export type RootStackParamList = {
  Connections: undefined
  Pair: { editId?: string } | undefined
  Projects: { connectionId: string; label: string }
  Conversations: { connectionId: string; projectPath: string; projectName: string }
  Thread: { connectionId: string; threadId: string; title: string; projectPath: string; isNew?: boolean }
  NewSession: { connectionId: string; projectPath: string; projectName: string }
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

export default function App() {
  return (
    <NavigationContainer theme={theme}>
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
        <Stack.Screen name="Pair" component={PairScreen} options={{ title: 'Pair backend', presentation: 'modal' }} />
        <Stack.Screen name="Projects" component={ProjectsScreen} options={({ route }) => ({ title: route.params.label })} />
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
      </Stack.Navigator>
    </NavigationContainer>
  )
}
