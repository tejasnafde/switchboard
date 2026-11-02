/**
 * Home > Recents above the machine list: the newest chats on every paired
 * machine, what each needs, and a tap straight into the chat. A long press or
 * a leftward swipe opens the Snooze sheet; snoozed chats wait in the Snoozed
 * shelf at the end. Rules in lib/home-recents.ts and lib/snooze-sheet.ts.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ActivityIndicator, Animated, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useFocusEffect } from '@react-navigation/native'
import { CHAT_SNOOZE_CAPABILITY, wakeLabel } from '@shared/chat-snooze'
import { snoozePrOf, type SnoozePrChoice } from '@shared/chat-snooze-pr'
import { createLogger } from '@shared/logger'
import { colors, fonts, radius, space, type, HIT } from '../theme'
import {
  HOME_RECENT_PAGE_SIZE,
  canSnooze,
  homeRecents,
  homeRelativeTime,
  type HomeRecentRow,
  type HomeRecentStatus,
  type HomeRecentsPage,
} from '../lib/home-recents'
import { rowSwipeCommits, shouldClaimRowSwipe } from '../lib/gestures'
import { snoozeSheetItems, type SnoozeSheetItem } from '../lib/snooze-sheet'
import { useChatStore } from '../stores/chat'
import { getClient, useConnectionsStore } from '../stores/connections'
import { snoozeChat, useRecentsStore, wakeChat } from '../stores/recents'
import { SnoozeSheet } from './SnoozeSheet'

const log = createLogger('home:snooze')

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
  const [sheet, setSheet] = useState<SnoozeSheetState | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

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
          // The capability arrives with the `ready` frame, before the reply that fills `sessions`.
          snooze: getClient(c.id)?.supportsCapability(CHAT_SNOOZE_CAPABILITY) === true,
        })),
        threads,
        limit,
      ),
    [configs, status, sessions, live, threads, limit],
  )

  useEffect(() => {
    if (notice === null) return
    const timer = setTimeout(() => setNotice(null), NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])

  const openSheet = (row: HomeRecentRow) => {
    const opened: SnoozeSheetState = { row, now: new Date(), pr: null, notice: null, busy: false }
    setSheet(opened)
    getClient(row.connectionId)
      ?.pullRequestLinks(row.id)
      .then(
        (links) => {
          const pr = snoozePrOf(links)
          if (pr) setSheet((s) => (s?.row === row ? { ...s, pr } : s))
        },
        (err: unknown) => log.warn(`could not read the PR links of ${row.id}`, err),
      )
  }

  const pick = async (item: SnoozeSheetItem) => {
    if (!sheet) return
    const { row } = sheet
    setSheet({ ...sheet, busy: true, notice: null })
    const refused = await snoozeChat(row.connectionId, row.id, item.choice)
    setSheet((s) => (s?.row !== row ? s : refused === null ? null : { ...s, busy: false, notice: refused }))
  }

  const wake = async (row: HomeRecentRow) => {
    const refused = await wakeChat(row.connectionId, row.id)
    if (refused !== null) setNotice(refused)
  }

  return (
    <>
      <RecentsList
        page={page}
        notice={notice}
        onOpen={onOpen}
        onSnooze={openSheet}
        onWake={(row) => void wake(row)}
        onShowMore={() => setLimit((n) => Math.min(n + HOME_RECENT_PAGE_SIZE, page.total))}
      />
      {sheet && (
        <SnoozeSheet
          title={sheet.row.title}
          items={snoozeSheetItems(sheet.now, sheet.pr)}
          notice={sheet.notice}
          busy={sheet.busy}
          onPick={(item) => void pick(item)}
          onClose={() => setSheet(null)}
        />
      )}
    </>
  )
}

const NOTICE_MS = 5000

interface SnoozeSheetState {
  row: HomeRecentRow
  /** When the sheet opened: its clock-time presets keep this instant. */
  now: Date
  pr: SnoozePrChoice | null
  notice: string | null
  busy: boolean
}

export function RecentsList({
  page,
  notice = null,
  onOpen,
  onShowMore,
  onSnooze,
  onWake,
}: {
  page: HomeRecentsPage
  notice?: string | null
  onOpen: (row: HomeRecentRow) => void
  onShowMore: () => void
  onSnooze?: (row: HomeRecentRow) => void
  onWake?: (row: HomeRecentRow) => void
}) {
  const [shelfOpen, setShelfOpen] = useState(false)
  const now = new Date()
  return (
    <View>
      <Text style={styles.overline}>Recents</Text>
      {notice !== null && (
        <Text style={styles.notice} accessibilityLiveRegion="polite">
          {notice}
        </Text>
      )}
      {page.items.length === 0 && page.snoozed.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No recent chats yet</Text>
          <Text style={styles.emptyBody}>Open a machine and choose a project to start or resume a chat.</Text>
        </View>
      ) : (
        page.items.map((row) => {
          const snoozable = onSnooze !== undefined && canSnooze(row)
          return (
            <SwipeToSnooze key={`${row.connectionId}:${row.id}`} enabled={snoozable} onSwipe={() => onSnooze?.(row)}>
              <Pressable
                testID={`recent-${row.connectionId}:${row.id}`}
                accessibilityRole="button"
                accessibilityHint={snoozable ? 'Long press to snooze' : undefined}
                onPress={() => onOpen(row)}
                onLongPress={snoozable ? () => onSnooze?.(row) : undefined}
                style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              >
                <View style={styles.body}>
                  <Text style={[styles.title, row.woke && styles.titleWoke]} numberOfLines={1}>
                    {row.title}
                  </Text>
                  <Text style={styles.meta} numberOfLines={1}>
                    {`${row.projectName} · ${row.connectionLabel}`}
                  </Text>
                </View>
                <Trailing row={row} />
              </Pressable>
            </SwipeToSnooze>
          )
        })
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
      {page.snoozed.length > 0 && (
        <Pressable
          testID="recents-snoozed"
          accessibilityRole="button"
          accessibilityState={{ expanded: shelfOpen }}
          onPress={() => setShelfOpen((open) => !open)}
          style={({ pressed }) => [styles.shelf, pressed && styles.pressed]}
        >
          <Ionicons name={shelfOpen ? 'chevron-down' : 'chevron-forward'} size={14} color={colors.textDim} />
          <Text style={styles.shelfText}>{`Snoozed ${page.snoozed.length}`}</Text>
        </Pressable>
      )}
      {shelfOpen &&
        page.snoozed.map((row) => (
          <Pressable
            key={`${row.connectionId}:${row.id}`}
            testID={`snoozed-${row.connectionId}:${row.id}`}
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
            <Text style={styles.time}>{wakeLabel(row.snoozedUntil ?? null, row.snoozePr ?? null, now)}</Text>
            {onWake && (
              <Pressable
                testID={`wake-${row.connectionId}:${row.id}`}
                accessibilityRole="button"
                accessibilityLabel={`Wake ${row.title}`}
                hitSlop={8}
                onPress={() => onWake(row)}
                style={({ pressed }) => [styles.wake, pressed && styles.pressed]}
              >
                <Text style={styles.wakeText}>Wake</Text>
              </Pressable>
            )}
          </Pressable>
        ))}
    </View>
  )
}

/** A leftward swipe on a row opens its Snooze sheet; the row springs back. */
function SwipeToSnooze({ enabled, onSwipe, children }: { enabled: boolean; onSwipe: () => void; children: ReactNode }) {
  const translateX = useRef(new Animated.Value(0)).current
  const swipe = useRef(onSwipe)
  swipe.current = onSwipe
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_e, g) => shouldClaimRowSwipe(g.dx, g.dy),
        onPanResponderMove: (_e, g) => translateX.setValue(Math.min(0, g.dx)),
        onPanResponderRelease: (_e, g) => {
          if (rowSwipeCommits(g.dx, g.vx)) swipe.current()
          Animated.spring(translateX, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start()
        },
        onPanResponderTerminate: () =>
          Animated.spring(translateX, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start(),
      }),
    [translateX],
  )
  if (!enabled) return <>{children}</>
  return (
    <Animated.View style={{ transform: [{ translateX }] }} {...responder.panHandlers}>
      {children}
    </Animated.View>
  )
}

function Trailing({ row }: { row: HomeRecentRow }) {
  if (row.woke && (row.status === null || row.status === 'Done'))
    return <Text style={[styles.statusText, styles.woke]}>Woke</Text>
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
  titleWoke: { fontFamily: fonts.displayBold },
  woke: { color: colors.accent },
  notice: { ...type.bodySm, color: colors.amber, paddingBottom: space.xs, paddingHorizontal: 2 },
  shelf: { minHeight: HIT, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 2 },
  shelfText: { ...type.bodySm, color: colors.textDim },
  wake: { paddingHorizontal: space.sm, paddingVertical: 4 },
  wakeText: { ...type.bodySm, color: colors.accent },
})
