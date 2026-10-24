/**
 * Home > Recents above the machine list: the newest chats on every paired
 * machine, what each needs, and a tap straight into the chat. Rules in
 * lib/home-recents.ts.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { useFocusEffect } from '@react-navigation/native'
import { colors, radius, space, type, HIT } from '../theme'
import {
  HOME_RECENT_PAGE_SIZE,
  homeRecents,
  homeRelativeTime,
  type HomeRecentRow,
  type HomeRecentStatus,
  type HomeRecentsPage,
} from '../lib/home-recents'
import { useChatStore } from '../stores/chat'
import { useConnectionsStore } from '../stores/connections'
import { useRecentsStore } from '../stores/recents'

const STATUS_COLOR: Record<HomeRecentStatus, string> = {
  Approval: colors.amber,
  Input: colors.amber,
  Working: colors.accent,
  Failed: colors.red,
  Done: colors.green,
}

function refreshConnected() {
  const { configs, status } = useConnectionsStore.getState()
  for (const c of configs) if (status[c.id] === 'connected') void useRecentsStore.getState().refresh(c.id)
}

export function HomeRecents({ onOpen }: { onOpen: (row: HomeRecentRow) => void }) {
  const configs = useConnectionsStore((s) => s.configs)
  const status = useConnectionsStore((s) => s.status)
  const sessions = useRecentsStore((s) => s.sessions)
  const live = useRecentsStore((s) => s.live)
  const threads = useChatStore((s) => s.threads)
  const staleGeneration = useChatStore((s) => s.staleGeneration)
  const [limit, setLimit] = useState(HOME_RECENT_PAGE_SIZE)

  const connected = configs
    .filter((c) => status[c.id] === 'connected')
    .map((c) => c.id)
    .join(',')
  // Asked on every Home visit, when a machine connects and after a resume gap:
  // live events miss a turn that ended while this app was disconnected or not
  // running.
  useFocusEffect(refreshConnected)
  const refreshed = useRef(new Set(connected.split(',')))
  useEffect(() => {
    const ids = new Set(connected.split(','))
    for (const id of ids) if (id && !refreshed.current.has(id)) void useRecentsStore.getState().refresh(id)
    refreshed.current = ids
  }, [connected])
  const seenGeneration = useRef(staleGeneration)
  useEffect(() => {
    if (staleGeneration === seenGeneration.current) return
    seenGeneration.current = staleGeneration
    refreshConnected()
  }, [staleGeneration])

  const page = useMemo(
    () =>
      homeRecents(
        configs.map((c) => ({
          connectionId: c.id,
          label: c.label,
          connected: status[c.id] === 'connected',
          sessions: sessions[c.id] ?? [],
          live: live[c.id],
        })),
        threads,
        limit,
      ),
    [configs, status, sessions, live, threads, limit],
  )

  return (
    <RecentsList
      page={page}
      onOpen={onOpen}
      onShowMore={() => setLimit((n) => Math.min(n + HOME_RECENT_PAGE_SIZE, page.total))}
    />
  )
}

export function RecentsList({
  page,
  onOpen,
  onShowMore,
}: {
  page: HomeRecentsPage
  onOpen: (row: HomeRecentRow) => void
  onShowMore: () => void
}) {
  return (
    <View>
      <Text style={styles.overline}>Recents</Text>
      {page.items.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No recent chats yet</Text>
          <Text style={styles.emptyBody}>Open a machine and choose a project to start or resume a chat.</Text>
        </View>
      ) : (
        page.items.map((row) => (
          <Pressable
            key={`${row.connectionId}:${row.id}`}
            testID={`recent-${row.connectionId}:${row.id}`}
            accessibilityRole="button"
            onPress={() => onOpen(row)}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          >
            <View style={styles.body}>
              <Text style={styles.title} numberOfLines={1}>
                {row.title}
              </Text>
              <Text style={styles.meta} numberOfLines={1}>
                {`${row.projectName} · ${row.connectionLabel}`}
              </Text>
            </View>
            <Trailing row={row} />
          </Pressable>
        ))
      )}
      {page.items.length < page.total && (
        <Pressable
          testID="recents-show-more"
          accessibilityRole="button"
          onPress={onShowMore}
          style={({ pressed }) => [styles.more, pressed && styles.pressed]}
        >
          <Text style={styles.moreText}>Show more</Text>
        </Pressable>
      )}
    </View>
  )
}

function Trailing({ row }: { row: HomeRecentRow }) {
  if (row.status === null) return <Text style={styles.time}>{homeRelativeTime(row.startedAt)}</Text>
  const color = STATUS_COLOR[row.status]
  return (
    <View style={styles.status}>
      {row.status === 'Working' ? (
        <ActivityIndicator size="small" color={color} style={styles.spinner} />
      ) : (
        <View style={[styles.dot, { backgroundColor: color }]} />
      )}
      <Text style={[styles.statusText, { color }]}>{row.status}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  overline: {
    ...type.label,
    color: colors.textDim,
    textTransform: 'uppercase',
    paddingTop: space.md,
    paddingBottom: 6,
    paddingHorizontal: 2,
  },
  empty: { paddingVertical: space.sm, gap: space.xs },
  emptyTitle: { ...type.heading, color: colors.text },
  emptyBody: { ...type.bodySm, color: colors.textDim },
  row: {
    minHeight: HIT + 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
    paddingHorizontal: 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  body: { flex: 1, gap: 2 },
  title: { ...type.heading, color: colors.text },
  meta: { ...type.meta, color: colors.textDim },
  time: { ...type.monoSm, color: colors.textDim },
  status: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  spinner: { transform: [{ scale: 0.6 }], width: 12, height: 12 },
  dot: { width: 7, height: 7, borderRadius: radius.pill },
  statusText: { ...type.monoSm },
  more: { minHeight: HIT, alignItems: 'center', justifyContent: 'center' },
  moreText: { ...type.bodySm, color: colors.accent },
  pressed: { opacity: 0.55 },
})
