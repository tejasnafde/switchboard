/**
 * Project list for one paired backend. Fetches on focus, pull-to-refresh,
 * and shows a per-project unread pill summed from the chat store's threads.
 */
import { memo, useCallback, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useFocusEffect } from '@react-navigation/native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { Project } from '@shared/types'
import type { RootStackParamList } from '../../App'
import { colors, fonts, radius, space, type, HIT } from '../theme'
import { getClient } from '../stores/connections'
import { useChatStore, threadKey } from '../stores/chat'
import { UnreadPill } from '../components/UnreadPill'

type Props = NativeStackScreenProps<RootStackParamList, 'Projects'>

/**
 * Per-row unread pill with its own primitive selector, so an unread bump in
 * one thread re-renders just this pill - never the whole project list.
 */
const ProjectUnread = memo(function ProjectUnread({
  connectionId,
  sessionIds,
}: {
  connectionId: string
  sessionIds: string[]
}) {
  const count = useChatStore((s) => {
    let n = 0
    for (const sid of sessionIds) n += s.threads[threadKey(connectionId, sid)]?.unread ?? 0
    return n
  })
  return <UnreadPill count={count} />
})

export default function ProjectsScreen({ route, navigation }: Props) {
  const { connectionId } = route.params
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(
    async (asRefresh = false) => {
      if (asRefresh) setRefreshing(true)
      const client = getClient(connectionId)
      if (!client) {
        setError('Backend not connected yet.')
        setRefreshing(false)
        return
      }
      try {
        const result = await client.getProjects()
        setProjects(result)
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setRefreshing(false)
      }
    },
    [connectionId],
  )

  useFocusEffect(
    useCallback(() => {
      void load()
    }, [load]),
  )

  if (projects === null && error !== null) {
    // The transport may still be dialing (reconnects are internal to it), so
    // frame the failure as "connecting" rather than a hard error.
    return (
      <View style={styles.center}>
        <Text style={styles.stateTitle}>Connecting to backend...</Text>
        <Text style={styles.stateDetail} numberOfLines={2}>
          {error}
        </Text>
        <Pressable style={styles.retryButton} onPress={() => void load()}>
          <Text style={styles.retryLabel}>Retry</Text>
        </Pressable>
      </View>
    )
  }

  if (projects === null) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    )
  }

  return (
    <FlatList
      data={projects}
      keyExtractor={(p) => p.path}
      contentContainerStyle={projects.length === 0 ? styles.emptyContainer : styles.listContent}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void load(true)}
          tintColor={colors.textDim}
        />
      }
      ListEmptyComponent={
        <View style={styles.center}>
          <Text style={styles.stateTitle}>No projects</Text>
          <Text style={styles.stateDetail}>Add a project on the desktop app to see it here.</Text>
        </View>
      }
      renderItem={({ item }) => {
        return (
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() =>
              navigation.navigate('Conversations', {
                connectionId,
                projectPath: item.path,
                projectName: item.name,
              })
            }
          >
            <View style={styles.rowBody}>
              <View style={styles.titleLine}>
                <Text style={styles.name} numberOfLines={1}>
                  {item.name}
                </Text>
                <ProjectUnread
                  connectionId={connectionId}
                  sessionIds={item.sessions.map((s) => s.id)}
                />
              </View>
              <Text style={styles.meta}>
                {item.sessions.length} {item.sessions.length === 1 ? 'session' : 'sessions'}
              </Text>
              <Text style={styles.path} numberOfLines={1} ellipsizeMode="middle">
                {item.path}
              </Text>
            </View>
          </Pressable>
        )
      }}
    />
  )
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
    gap: space.sm,
  },
  emptyContainer: {
    flexGrow: 1,
  },
  listContent: {
    paddingVertical: space.xs,
  },
  stateTitle: {
    ...type.heading,
    color: colors.text,
  },
  stateDetail: {
    ...type.bodySm,
    color: colors.textDim,
    textAlign: 'center',
  },
  retryButton: {
    marginTop: space.md,
    minHeight: HIT,
    paddingHorizontal: space.lg,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    backgroundColor: colors.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  retryLabel: {
    fontFamily: fonts.display,
    fontSize: 15,
    color: colors.accent,
  },
  row: {
    minHeight: HIT,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowPressed: {
    backgroundColor: colors.surface,
  },
  rowBody: {
    gap: 3,
  },
  titleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  name: {
    flexShrink: 1,
    ...type.heading,
    color: colors.text,
  },
  meta: {
    ...type.bodySm,
    color: colors.textDim,
  },
  path: {
    ...type.mono,
    color: colors.textFaint,
  },
})
