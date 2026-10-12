/**
 * Reviews for one paired backend: the pull requests the desktop reads,
 * grouped by the desktop's rule (`shared/pull-request-groups.ts`) through
 * `shared/pull-request-phone.ts`. Read-only; a row opens the detail.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Pressable, RefreshControl, ScrollView, SectionList, StyleSheet, Text, TextInput, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useFocusEffect } from '@react-navigation/native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { createLogger } from '@shared/logger'
import { prKey, type PrSummary } from '@shared/pull-requests'
import type { PrRowIcon, PrRowStatus } from '@shared/pull-request-groups'
import {
  filterPhonePrs,
  needsYouCount,
  phonePrFiltersActive,
  phonePrHostErrors,
  phonePrHosts,
  phonePrSections,
  phonePrSubtitle,
  prAgeLabel,
  type PhonePrFilters,
  type PhonePrShow,
} from '@shared/pull-request-phone'
import type { RootStackParamList } from '../../App'
import { colors, fonts, radius, space, type, HIT } from '../theme'
import { ConnectionTabBar } from '../components/ConnectionTabBar'
import { PrFilterSheet } from '../components/PrFilterSheet'
import { prFiltersFor, usePrefsStore } from '../stores/prefs'
import { reviewsEntry, useReviewsStore } from '../stores/reviews'
import { getClient } from '../stores/connections'

const log = createLogger('screen:reviews')

type Props = NativeStackScreenProps<RootStackParamList, 'Reviews'>

/** One glyph and one tone per row status, as on the desktop. */
const ROW_ICON: Record<PrRowIcon, { name: keyof typeof Ionicons.glyphMap; color: string }> = {
  failed: { name: 'close-circle-outline', color: colors.red },
  conflict: { name: 'warning-outline', color: colors.red },
  review: { name: 'eye-outline', color: colors.accent },
  conversation: { name: 'chatbox-outline', color: colors.amber },
  running: { name: 'sync-outline', color: colors.amber },
  waiting: { name: 'time-outline', color: colors.textDim },
  ready: { name: 'checkmark-circle-outline', color: colors.green },
  merged: { name: 'git-merge-outline', color: colors.purple },
  draft: { name: 'ellipse-outline', color: colors.textDim },
}

function phraseColor(icon: PrRowIcon): string {
  if (icon === 'failed' || icon === 'conflict') return colors.red
  if (icon === 'running' || icon === 'conversation') return colors.amber
  if (icon === 'ready') return colors.green
  return colors.text
}

const CHIPS: Array<{ show: PhonePrShow; label: string }> = [
  { show: 'all', label: 'All' },
  { show: 'needs-you', label: 'Needs you' },
  { show: 'mine', label: 'Mine' },
  { show: 'reviewing', label: 'Reviewing' },
]

function minutesAgo(at: number, now: number): string {
  const minutes = Math.max(1, Math.round((now - at) / 60_000))
  return minutes === 1 ? '1 min' : `${minutes} min`
}

function PrRow({ pr, status, now, onPress }: { pr: PrSummary; status: PrRowStatus; now: number; onPress: () => void }) {
  const icon = ROW_ICON[status.icon]
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={onPress}
      accessibilityRole="button"
      testID={`pr-row-${pr.ref.number}`}
    >
      <Ionicons name={icon.name} size={18} color={icon.color} style={styles.rowIcon} />
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {pr.title}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          <Text style={styles.rowRepo}>{`${pr.ref.owner}/${pr.ref.name} #${pr.ref.number}`}</Text>
          {status.phrase ? <Text style={{ color: phraseColor(status.icon) }}>{` · ${status.phrase}`}</Text> : null}
        </Text>
      </View>
      <Text style={styles.rowAge}>
        {prAgeLabel(status.group === 'merged' ? (pr.mergedAt ?? pr.updatedAt) : pr.updatedAt, now)}
      </Text>
    </Pressable>
  )
}

export default function ReviewsScreen({ route, navigation }: Props) {
  const { connectionId, label } = route.params
  const entry = useReviewsStore((s) => reviewsEntry(s, connectionId))
  const refresh = useReviewsStore((s) => s.refresh)
  const saved = usePrefsStore((s) => s.prFilters[connectionId])
  const filters = useMemo(() => prFiltersFor({ [connectionId]: saved }, connectionId), [connectionId, saved])
  const setFilters = useCallback(
    (next: PhonePrFilters) => usePrefsStore.getState().setPrFilters(connectionId, next),
    [connectionId],
  )
  const [query, setQuery] = useState('')
  const [sheetOpen, setSheetOpen] = useState(false)
  const [showMerged, setShowMerged] = useState(false)
  const [unhideError, setUnhideError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now)

  useFocusEffect(
    useCallback(() => {
      const first = reviewsEntry(useReviewsStore.getState(), connectionId).lastFetchAt === null
      void refresh(connectionId, first ? 'open' : 'focus')
      // The interval read gates itself to every 5 minutes; this only asks.
      const timer = setInterval(() => {
        setNow(Date.now())
        void refresh(connectionId, 'interval')
      }, 60_000)
      return () => clearInterval(timer)
    }, [connectionId, refresh]),
  )
  useEffect(() => setNow(Date.now()), [entry.data])

  const data = entry.data
  const listed = useMemo(
    () => (data ? filterPhonePrs(data.prs, data.hidden, filters, query, now) : []),
    [data, filters, query, now],
  )
  const openCount = listed.filter((pr) => pr.state === 'open').length
  const mergedOnly = listed.length > 0 && openCount === 0
  const sections = useMemo(
    () =>
      phonePrSections(listed, filters.groupBy, now)
        .map((s) => ({ ...s, data: mergedOnly && !showMerged ? [] : s.rows }))
        .filter((s) => s.data.length > 0),
    [listed, filters.groupBy, now, mergedOnly, showMerged],
  )
  const hostErrors = data ? phonePrHostErrors(data.sources) : []
  const subtitle = data
    ? phonePrSubtitle(
        openCount,
        hostErrors.map((e) => e.host),
        phonePrHosts(data.sources),
      )
    : 'reading pull requests'
  const needsYou = data ? needsYouCount(data.prs, data.hidden, now) : 0
  const hiddenRepos = data?.hiddenRepos ?? []

  const switchTab = (tab: 'projects' | 'reviews') => {
    if (tab === 'projects') navigation.replace('Projects', { connectionId, label, viaTab: true })
  }
  const showHiddenRepos = () => {
    setUnhideError(null)
    const fail = (message: string) => setUnhideError(`Could not show them: ${message}`)
    const client = getClient(connectionId)
    if (!client) return fail('the backend is not connected.')
    client
      .unhidePullRequestRepos(hiddenRepos)
      .then((result) => (result.ok ? refresh(connectionId, 'manual') : fail('the desktop refused.')))
      .catch((err: unknown) => {
        log.warn('showing hidden repositories failed', err)
        fail(err instanceof Error ? err.message : String(err))
      })
  }
  const setShow = (show: PhonePrShow) => setFilters({ ...filters, show })

  const header = (
    <View style={styles.header}>
      <View style={styles.subtitleRow}>
        <View style={styles.dot} />
        <Text style={styles.subtitle}>{`${label} · ${subtitle}`}</Text>
      </View>
      <View style={styles.searchRow}>
        <View style={styles.search}>
          <Ionicons name="search" size={16} color={colors.textFaint} />
          <TextInput
            style={styles.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder="Filter pull requests"
            placeholderTextColor={colors.textFaint}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
          />
        </View>
        <Pressable
          style={styles.filterButton}
          onPress={() => setSheetOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="Filters"
          testID="pr-filter-button"
        >
          <Ionicons name="options-outline" size={20} color={colors.text} />
          {phonePrFiltersActive(filters) && <View style={styles.filterDot} testID="pr-filter-dot" />}
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {CHIPS.map((chip) => {
          const on = filters.show === chip.show
          return (
            <Pressable
              key={chip.show}
              style={[styles.chip, on && styles.chipOn]}
              onPress={() => setShow(chip.show)}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
            >
              <Text style={[styles.chipText, on && styles.chipTextOn]}>
                {chip.show === 'needs-you' && needsYou > 0 ? `${chip.label} · ${needsYou}` : chip.label}
              </Text>
            </Pressable>
          )
        })}
        <Pressable
          style={[styles.chip, filters.groupBy === 'repository' && styles.chipOn]}
          onPress={() =>
            setFilters({ ...filters, groupBy: filters.groupBy === 'repository' ? 'status' : 'repository' })
          }
          accessibilityRole="button"
          accessibilityState={{ selected: filters.groupBy === 'repository' }}
        >
          <Text style={[styles.chipText, filters.groupBy === 'repository' && styles.chipTextOn]}>By repo</Text>
        </Pressable>
      </ScrollView>
      {hostErrors.map((e) => (
        <View key={e.host} style={styles.errorCard} testID={`pr-host-error-${e.host}`}>
          <View style={styles.errorTitleRow}>
            <Ionicons name="close-circle-outline" size={16} color={colors.red} />
            <Text style={styles.errorTitle}>{e.title}</Text>
          </View>
          <Text style={styles.errorBody}>{e.message}</Text>
          <Pressable onPress={() => void refresh(connectionId, 'manual')} accessibilityRole="button" hitSlop={8}>
            <Text style={styles.link}>Try again</Text>
          </Pressable>
        </View>
      ))}
      {entry.error && data && (
        <View style={styles.staleRow} testID="pr-stale">
          <Ionicons name="cloud-offline-outline" size={14} color={colors.amber} />
          <Text style={styles.staleText}>{`Last read from the desktop ${minutesAgo(data.fetchedAt, now)} ago`}</Text>
        </View>
      )}
      {entry.error && !data && !entry.inFlight && (
        <View style={styles.errorCard}>
          <Text style={styles.errorTitle}>{"Couldn't read pull requests"}</Text>
          <Text style={styles.errorBody}>{entry.error}</Text>
          <Pressable onPress={() => void refresh(connectionId, 'manual')} accessibilityRole="button" hitSlop={8}>
            <Text style={styles.link}>Try again</Text>
          </Pressable>
        </View>
      )}
    </View>
  )

  const empty =
    data && sections.length === 0 ? (
      <View style={styles.empty} testID="pr-empty">
        <View style={styles.emptyIcon}>
          <Ionicons name="checkmark-circle-outline" size={20} color={colors.green} />
        </View>
        <Text style={styles.emptyTitle}>
          {query.trim() || phonePrFiltersActive(filters) || filters.show !== 'all'
            ? 'No matches'
            : 'Nothing open that involves you'}
        </Text>
        <Text style={styles.emptyBody}>
          {
            "Pull requests you authored, were asked to review, or commented on show here. They are read through this desktop's GitHub and Bitbucket accounts."
          }
        </Text>
        {mergedOnly && (
          <Pressable onPress={() => setShowMerged(true)} accessibilityRole="button" hitSlop={8}>
            <Text style={styles.link}>{`${listed.length} merged this week ›`}</Text>
          </Pressable>
        )}
      </View>
    ) : null

  return (
    <View style={styles.screen}>
      <SectionList
        sections={sections}
        keyExtractor={(row) => prKey(row.pr.ref)}
        stickySectionHeadersEnabled={false}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        ListFooterComponent={
          hiddenRepos.length > 0 ? (
            <Text style={styles.hiddenRepos}>
              {`${hiddenRepos.length} ${hiddenRepos.length === 1 ? 'repository' : 'repositories'} hidden · `}
              <Text style={styles.link} onPress={showHiddenRepos}>
                Show
              </Text>
              {unhideError ? `\n${unhideError}` : ''}
            </Text>
          ) : null
        }
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>{section.title.toUpperCase()}</Text>
            <Text style={styles.sectionCount}>{section.rows.length}</Text>
          </View>
        )}
        renderItem={({ item }) => (
          <PrRow
            pr={item.pr}
            status={item.status}
            now={now}
            onPress={() => navigation.navigate('PullRequest', { connectionId, ref: item.pr.ref, title: item.pr.title })}
          />
        )}
        refreshControl={
          <RefreshControl
            refreshing={entry.inFlight && data !== null}
            onRefresh={() => void refresh(connectionId, 'manual')}
            tintColor={colors.textDim}
          />
        }
      />
      {sheetOpen && data && (
        <PrFilterSheet
          filters={filters}
          prs={data.prs}
          hiddenCount={data.hidden.length}
          onChange={setFilters}
          onClose={() => setSheetOpen(false)}
        />
      )}
      <ConnectionTabBar active="reviews" connectionId={connectionId} onSelect={switchTab} />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: space.lg, paddingTop: space.sm, gap: space.sm },
  subtitleRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.green },
  subtitle: { ...type.bodySm, color: colors.textDim },
  searchRow: { flexDirection: 'row', gap: space.sm },
  search: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    minHeight: HIT - 4,
  },
  searchInput: { flex: 1, color: colors.text, ...type.body, paddingVertical: 0 },
  filterButton: {
    width: HIT - 4,
    height: HIT - 4,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterDot: {
    position: 'absolute',
    top: 7,
    right: 7,
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.accent,
  },
  chips: { gap: space.sm, paddingVertical: space.xs },
  chip: {
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    paddingHorizontal: space.md,
    paddingVertical: 6,
  },
  chipOn: { backgroundColor: colors.accentWash, borderColor: colors.accentWash },
  chipText: { ...type.bodySm, color: colors.text },
  chipTextOn: { color: colors.accent },
  errorCard: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(248,81,73,0.4)',
    backgroundColor: 'rgba(248,81,73,0.08)',
    padding: space.md,
    gap: space.xs,
  },
  errorTitleRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  errorTitle: { fontFamily: fonts.display, fontSize: 15, color: colors.red },
  errorBody: { ...type.bodySm, color: colors.textDim },
  link: { fontFamily: fonts.display, fontSize: 14, color: colors.accent },
  staleRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  staleText: { ...type.bodySm, color: colors.amber },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.xs,
  },
  sectionTitle: { ...type.label, color: colors.textDim },
  sectionCount: { ...type.monoSm, color: colors.textFaint },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowPressed: { backgroundColor: colors.surface },
  rowIcon: { marginTop: 2 },
  rowBody: { flex: 1, gap: 2 },
  rowTitle: { ...type.heading, fontSize: 15, color: colors.text },
  rowMeta: { ...type.bodySm, color: colors.text },
  rowRepo: { fontFamily: fonts.mono, fontSize: 12, color: colors.textDim },
  rowAge: { ...type.monoSm, color: colors.textFaint, marginTop: 2 },
  hiddenRepos: { ...type.bodySm, color: colors.textDim, textAlign: 'center', padding: space.lg },
  empty: { alignItems: 'center', paddingHorizontal: space.xl, paddingTop: space.xxl, gap: space.sm },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.md,
  },
  emptyTitle: { ...type.heading, fontSize: 18, color: colors.text, textAlign: 'center' },
  emptyBody: { ...type.bodySm, color: colors.textDim, textAlign: 'center' },
})
