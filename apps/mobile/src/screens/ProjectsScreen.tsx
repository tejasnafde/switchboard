/**
 * Project list for one paired backend. Fetches on focus, pull-to-refresh,
 * and shows a per-project unread pill summed from the chat store's threads.
 */
import { memo, useCallback, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useFocusEffect } from '@react-navigation/native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { Project, Workspace } from '@shared/types'
import { applyProjectOrder, groupProjectsByWorkspace } from '@shared/projectGrouping'
import { matchesQuery, parseOrder } from '../lib/projectList'
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
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [order, setOrder] = useState<string[] | null>(null)
  const [query, setQuery] = useState('')
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
        // Same backend tables the desktop sidebar reads, so grouping matches.
        // Neither is essential - a server that cannot answer still lists projects.
        const [result, ws, orderJson] = await Promise.all([
          client.getProjects(),
          client.listWorkspaces().catch(() => [] as Workspace[]),
          client.getSetting('projectOrder').catch(() => null),
        ])
        setProjects(result)
        setWorkspaces(ws)
        setOrder(parseOrder(orderJson))
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

  const sections = useMemo(() => {
    if (projects === null) return []
    const filtered = projects.filter((p) => matchesQuery(p, query))
    const ordered = applyProjectOrder(filtered, order)
    return groupProjectsByWorkspace(ordered, workspaces)
      // A workspace with no matches is noise while searching.
      .filter((g) => g.projects.length > 0)
      .map((g) => ({
        title: g.workspace?.name ?? 'Ungrouped',
        workspaceId: g.workspace?.id ?? null,
        data: g.projects,
      }))
  }, [projects, workspaces, order, query])

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
    <SectionList
      sections={sections}
      keyExtractor={(p) => p.path}
      contentContainerStyle={sections.length === 0 ? styles.emptyContainer : styles.listContent}
      keyboardShouldPersistTaps="handled"
      stickySectionHeadersEnabled={false}
      // A lone "Ungrouped" label above every project is clutter.
      renderSectionHeader={({ section }) =>
        sections.length > 1 ? (
          <Text style={styles.sectionHeader}>{section.title.toUpperCase()}</Text>
        ) : null
      }
      ListHeaderComponent={
        // Hidden until there are enough projects for finding one to be work.
        (projects?.length ?? 0) > 6 || query !== '' ? (
          <View style={styles.searchWrap}>
            <TextInput
              style={styles.searchInput}
              value={query}
              onChangeText={setQuery}
              placeholder="Search projects"
              placeholderTextColor={colors.textFaint}
              autoCorrect={false}
              autoCapitalize="none"
              returnKeyType="search"
              clearButtonMode="while-editing"
            />
          </View>
        ) : null
      }
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void load(true)}
          tintColor={colors.textDim}
        />
      }
      ListEmptyComponent={
        <View style={styles.center}>
          <Text style={styles.stateTitle}>{query === '' ? 'No projects' : 'No matches'}</Text>
          <Text style={styles.stateDetail}>
            {query === ''
              ? 'Add a project on the desktop app to see it here.'
              : `Nothing matches "${query.trim()}".`}
          </Text>
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
  searchWrap: { paddingBottom: space.sm },
  searchInput: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.sm,
    color: colors.text,
    paddingHorizontal: space.md,
    minHeight: HIT,
    ...type.body,
  },
  sectionHeader: {
    color: colors.textFaint,
    ...type.label,
    marginTop: space.md,
    marginBottom: space.xs,
  },
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
