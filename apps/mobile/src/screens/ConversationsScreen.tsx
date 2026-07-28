/**
 * Conversation list for one project on a paired backend. Fetches on focus,
 * newest first, with live status dots and unread badges from the chat store.
 */
import { memo, useCallback, useLayoutEffect, useState } from 'react'
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
import { agentShortLabel, isAgentType, type ConversationRow } from '@shared/types'
import { formatRelativeTime } from '@shared/format'
import type { RootStackParamList } from '../../App'
import { colors, fonts, radius, space, statusColor, type, HIT } from '../theme'
import { getClient } from '../stores/connections'
import { useChatStore, threadKey } from '../stores/chat'
import { UnreadPill } from '../components/UnreadPill'

type Props = NativeStackScreenProps<RootStackParamList, 'Conversations'>

function agentChipLabel(agentType: string): string {
  return isAgentType(agentType) ? agentShortLabel(agentType) : agentType
}

/**
 * Title line with live status dot + unread pill. Primitive selectors keyed to
 * one thread, so chat-store churn re-renders only the affected row - the list
 * itself never subscribes to the whole threads map.
 */
const RowMeta = memo(function RowMeta({ threadKeyStr, title }: { threadKeyStr: string; title: string }) {
  const unread = useChatStore((s) => s.threads[threadKeyStr]?.unread ?? 0)
  const status = useChatStore((s) => s.threads[threadKeyStr]?.status)
  return (
    <View style={styles.titleLine}>
      {status != null && (
        <View style={[styles.statusDot, { backgroundColor: statusColor[status] ?? colors.textFaint }]} />
      )}
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>
      <UnreadPill count={unread} />
    </View>
  )
})

export default function ConversationsScreen({ route, navigation }: Props) {
  const { connectionId, projectPath, projectName } = route.params
  const [rows, setRows] = useState<ConversationRow[] | null>(null)
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
        const result = await client.getConversations(projectPath)
        setRows([...result].sort((a, b) => b.updated_at - a.updated_at))
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setRefreshing(false)
      }
    },
    [connectionId, projectPath],
  )

  useFocusEffect(
    useCallback(() => {
      void load()
    }, [load]),
  )

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <Pressable
          hitSlop={12}
          onPress={() => navigation.navigate('NewSession', { connectionId, projectPath, projectName })}
          style={({ pressed }) => [styles.headerAction, pressed && styles.pressed]}
        >
          <Text style={styles.headerPlus}>+</Text>
        </Pressable>
      ),
    })
  }, [navigation, connectionId, projectPath, projectName])

  if (rows === null && error !== null) {
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

  if (rows === null) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    )
  }

  return (
    <FlatList
      data={rows}
      keyExtractor={(r) => r.id}
      contentContainerStyle={rows.length === 0 ? styles.emptyContainer : styles.listContent}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void load(true)}
          tintColor={colors.textDim}
        />
      }
      ListEmptyComponent={
        <View style={styles.center}>
          <Text style={styles.stateTitle}>No conversations</Text>
          <Text style={styles.stateDetail}>Tap + to start a new session in {projectName}.</Text>
        </View>
      }
      renderItem={({ item }) => {
        return (
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() =>
              navigation.navigate('Thread', {
                connectionId,
                threadId: item.id,
                title: item.title,
                projectPath,
              })
            }
          >
            <View style={styles.rowBody}>
              <RowMeta threadKeyStr={threadKey(connectionId, item.id)} title={item.title} />
              <View style={styles.metaLine}>
                <View style={styles.agentChip}>
                  <Text style={styles.agentChipText}>{agentChipLabel(item.agent_type)}</Text>
                </View>
                <Text style={styles.time}>{formatRelativeTime(item.updated_at)}</Text>
              </View>
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
  headerAction: {
    minHeight: HIT,
    justifyContent: 'center',
    paddingHorizontal: space.xs,
  },
  headerPlus: {
    color: colors.accent,
    fontSize: 27,
    lineHeight: 31,
    fontWeight: '300',
  },
  pressed: {
    opacity: 0.55,
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
    gap: space.xs,
  },
  titleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: radius.pill,
  },
  title: {
    flex: 1,
    ...type.heading,
    color: colors.text,
  },
  metaLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  agentChip: {
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  agentChipText: {
    ...type.monoSm,
    color: colors.textDim,
  },
  time: {
    ...type.monoSm,
    color: colors.textFaint,
  },
})
