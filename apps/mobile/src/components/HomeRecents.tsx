/**
 * Home > Recents above the machine list: the newest chats on every paired
 * machine, what each needs, and a tap straight into the chat. A long press or
 * a leftward swipe opens the Snooze sheet, with Settle for a Done or idle chat;
 * snoozed chats wait in the Snoozed shelf at the end. A settle made here, or a
 * merged PR's settle while Home is shown, offers Undo for 8 s. Rules in
 * lib/home-recents.ts and lib/snooze-sheet.ts.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ActivityIndicator, Animated, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useFocusEffect } from '@react-navigation/native'
import { CHAT_SETTLE_CAPABILITY, SETTLE_UNDO_MS, settledNoticeText } from '@shared/chat-settle'
import { CHAT_SNOOZE_CAPABILITY, DEFAULT_SNOOZE_PRESETS, wakeLabel, type SnoozePresetSpec } from '@shared/chat-snooze'
import { snoozePrOf, type SnoozePrChoice } from '@shared/chat-snooze-pr'
import { bridgeChecksLabel, bridgeOriginLabel } from '@shared/bridge'
import { createLogger } from '@shared/logger'
import { colors, fonts, radius, space, type, HIT } from '../theme'
import {
  HOME_RECENT_PAGE_SIZE,
  canSettle,
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
import {
  onMergeSettled,
  settleChat,
  snoozeChat,
  undoSettle,
  useRecentsStore,
  wakeChat,
  type SettleUndo,
} from '../stores/recents'
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
  const [undo, setUndo] = useState<SettleUndo | null>(null)
  // The open sheet's opening instant: a reply to an earlier opening of the same row does not apply.
  const openedAt = useRef<Date | null>(null)

  const connected = configs
    .filter((c) => status[c.id] === 'connected')
    .map((c) => c.id)
    .join(',')
  // Asked on every Home visit, when a machine connects and after a resume gap:
  // live events miss a turn that ended while this app was disconnected or not
  // running.
  useFocusEffect(refreshConnected)
  useFocusEffect(useCallback(() => onMergeSettled(setUndo), []))
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
          settle: getClient(c.id)?.supportsCapability(CHAT_SETTLE_CAPABILITY) === true,
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

  useEffect(() => {
    if (undo === null) return
    const timer = setTimeout(() => setUndo((current) => (current === undo ? null : current)), SETTLE_UNDO_MS)
    return () => clearTimeout(timer)
  }, [undo])

  const openSheet = (row: HomeRecentRow) => {
    const now = new Date()
    openedAt.current = now
    const presets = useRecentsStore.getState().presets[row.connectionId] ?? DEFAULT_SNOOZE_PRESETS
    setSheet({ row, now, presets, pr: null, notice: null, busy: false })
    if (!canSnooze(row)) return
    getClient(row.connectionId)
      ?.pullRequestLinks(row.id)
      .then(
        (links) => {
          if (openedAt.current === now) setSheet((s) => s && { ...s, pr: snoozePrOf(links) })
        },
        (err: unknown) => log.warn(`could not read the PR links of ${row.id}`, err),
      )
  }

  const pick = async (item: SnoozeSheetItem) => {
    if (!sheet) return
    const { row } = sheet
    setSheet({ ...sheet, busy: true, notice: null })
    const refused = await snoozeChat(row.connectionId, row.id, item.choice)
    if (openedAt.current !== sheet.now) {
      // The sheet closed while the request ran: the refusal shows above Recents instead.
      if (refused !== null) setNotice(refused)
      return
    }
    if (refused === null) closeSheet()
    else setSheet((s) => s && { ...s, busy: false, notice: refused })
  }

  const closeSheet = () => {
    openedAt.current = null
    setSheet(null)
  }

  const settle = async (row: HomeRecentRow) => {
    closeSheet()
    const offered: SettleUndo = {
      connectionId: row.connectionId,
      id: row.id,
      settledAt: Date.now(),
      text: settledNoticeText(row.title),
    }
    setUndo(offered)
    const refused = await settleChat(row.connectionId, row.id, offered.settledAt)
    if (refused === null) return
    setUndo((current) => (current === offered ? null : current))
    setNotice(refused)
  }

  const undoNow = async () => {
    if (!undo) return
    setUndo(null)
    const refused = await undoSettle(undo)
    if (refused !== null) setNotice(refused)
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
        undo={undo?.text ?? null}
        onUndo={() => void undoNow()}
        onOpen={onOpen}
        onSnooze={openSheet}
        onWake={(row) => void wake(row)}
        onShowMore={() => setLimit((n) => Math.min(n + HOME_RECENT_PAGE_SIZE, page.total))}
      />
      {sheet && (
        <SnoozeSheet
          title={sheet.row.title}
          items={canSnooze(sheet.row) ? snoozeSheetItems(sheet.now, sheet.pr, sheet.presets) : []}
          notice={sheet.notice}
          busy={sheet.busy}
          onPick={(item) => void pick(item)}
          onSettle={canSettle(sheet.row) ? () => void settle(sheet.row) : undefined}
          onClose={closeSheet}
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
  /** The machine's presets when the sheet opened. */
  presets: readonly SnoozePresetSpec[]
  pr: SnoozePrChoice | null
  notice: string | null
  busy: boolean
}

export function RecentsList({
  page,
  notice = null,
  undo = null,
  onUndo,
  onOpen,
  onShowMore,
  onSnooze,
  onWake,
}: {
  page: HomeRecentsPage
  notice?: string | null
  /** A settle's notice, shown with Undo. */
  undo?: string | null
  onUndo?: () => void
  onOpen: (row: HomeRecentRow) => void
  onShowMore: () => void
  /** Opens a row's sheet: Snooze, and Settle for a Done or idle chat. */
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
      {undo !== null && (
        <View style={styles.undoRow}>
          <Text style={styles.undoText} numberOfLines={2} accessibilityLiveRegion="polite">
            {undo}
          </Text>
          {onUndo && (
            <Pressable
              testID="settle-undo"
              accessibilityRole="button"
              hitSlop={8}
              onPress={onUndo}
              style={({ pressed }) => [styles.wake, pressed && styles.pressed]}
            >
              <Text style={styles.wakeText}>Undo</Text>
            </Pressable>
          )}
        </View>
      )}
      {page.items.length === 0 && page.snoozed.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No recent chats yet</Text>
          <Text style={styles.emptyBody}>Open a machine and choose a project to start or resume a chat.</Text>
        </View>
      ) : (
        page.items.map((row) => {
          const hint = onSnooze === undefined ? undefined : sheetHint(canSnooze(row), canSettle(row))
          return (
            <SwipeToSnooze
              key={`${row.connectionId}:${row.id}`}
              enabled={hint !== undefined}
              onSwipe={() => onSnooze?.(row)}
            >
              <Pressable
                testID={`recent-${row.connectionId}:${row.id}`}
                accessibilityRole="button"
                accessibilityHint={hint}
                onPress={() => onOpen(row)}
                onLongPress={hint !== undefined ? () => onSnooze?.(row) : undefined}
                style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              >
                <View style={styles.body}>
                  <Text style={[styles.title, row.woke && styles.titleWoke]} numberOfLines={1}>
                    {row.title}
                  </Text>
                  <Text style={styles.meta} numberOfLines={1}>
                    {`${row.projectName} · ${row.connectionLabel}`}
                    {row.bridgeOrigin ? ` · ${bridgeOriginLabel(row.bridgeOrigin)}` : ''}
                    {row.bridgeOrigin?.checks ? ` · ${bridgeChecksLabel(row.bridgeOrigin.checks)}` : ''}
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

function sheetHint(snooze: boolean, settle: boolean): string | undefined {
  if (snooze && settle) return 'Long press to snooze or settle'
  if (snooze) return 'Long press to snooze'
  if (settle) return 'Long press to settle'
  return undefined
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
  undoRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingBottom: space.xs, paddingHorizontal: 2 },
  undoText: { ...type.bodySm, color: colors.text, flex: 1 },
  shelf: { minHeight: HIT, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 2 },
  shelfText: { ...type.bodySm, color: colors.textDim },
  wake: { paddingHorizontal: space.sm, paddingVertical: 4 },
  wakeText: { ...type.bodySm, color: colors.accent },
})
