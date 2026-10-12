/**
 * The Reviews filter sheet: group by, who is involved, checks, repositories,
 * drafts and hidden pull requests. Every change applies at once and is saved
 * per connection; hiding is the desktop's local list, so showing hidden PRs
 * reaches no host.
 */
import { Modal, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import type { PrSummary } from '@shared/pull-requests'
import {
  DEFAULT_PHONE_PR_FILTERS,
  phonePrRepos,
  toggleExcludedRepo,
  type PhonePrChecks,
  type PhonePrFilters,
  type PhonePrShow,
} from '@shared/pull-request-phone'
import { colors, fonts, radius, space, type, HIT } from '../theme'

function Chips<T extends string>({
  options,
  value,
  onPick,
}: {
  options: Array<{ value: T; label: string }>
  value: T
  onPick: (value: T) => void
}) {
  return (
    <View style={styles.chips}>
      {options.map((o) => {
        const on = o.value === value
        return (
          <Pressable
            key={o.value}
            style={[styles.chip, on && styles.chipOn]}
            onPress={() => onPick(o.value)}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
          >
            <Text style={[styles.chipText, on && styles.chipTextOn]}>{o.label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

const SHOW: Array<{ value: PhonePrShow; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'needs-you', label: 'Needs you' },
  { value: 'mine', label: 'Mine' },
  { value: 'reviewing', label: 'Reviewing' },
]

const CHECKS: Array<{ value: PhonePrChecks; label: string }> = [
  { value: 'any', label: 'Any' },
  { value: 'failing', label: 'Failing' },
  { value: 'running', label: 'Running' },
  { value: 'passing', label: 'Passing' },
]

export function PrFilterSheet({
  filters,
  prs,
  hiddenCount,
  onChange,
  onClose,
}: {
  filters: PhonePrFilters
  prs: PrSummary[]
  hiddenCount: number
  onChange: (filters: PhonePrFilters) => void
  onClose: () => void
}) {
  const repos = phonePrRepos(prs)
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()} testID="pr-filter-sheet">
          <View style={styles.grabber} />
          <View style={styles.titleRow}>
            <Text style={styles.title}>Filters</Text>
            <Pressable onPress={() => onChange(DEFAULT_PHONE_PR_FILTERS)} accessibilityRole="button" hitSlop={8}>
              <Text style={styles.reset}>Reset</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.body}>
            <Text style={styles.label}>GROUP BY</Text>
            <View style={styles.segment}>
              {(['status', 'repository'] as const).map((g) => {
                const on = filters.groupBy === g
                return (
                  <Pressable
                    key={g}
                    style={[styles.segmentItem, on && styles.segmentOn]}
                    onPress={() => onChange({ ...filters, groupBy: g })}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                  >
                    <Text style={[styles.segmentText, on && styles.segmentTextOn]}>
                      {g === 'status' ? 'Status' : 'Repository'}
                    </Text>
                  </Pressable>
                )
              })}
            </View>
            <Text style={styles.label}>SHOW</Text>
            <Chips options={SHOW} value={filters.show} onPick={(show) => onChange({ ...filters, show })} />
            <Text style={styles.label}>CHECKS</Text>
            <Chips options={CHECKS} value={filters.checks} onPick={(checks) => onChange({ ...filters, checks })} />
            {repos.length > 0 && <Text style={styles.label}>REPOSITORIES</Text>}
            {repos.map((repo) => {
              const on = !filters.excludedRepos.includes(repo.key)
              return (
                <Pressable
                  key={repo.key}
                  style={styles.listRow}
                  onPress={() => onChange(toggleExcludedRepo(filters, repo.key))}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                >
                  <Text style={styles.repo}>{repo.label}</Text>
                  {on && <Ionicons name="checkmark" size={18} color={colors.accent} />}
                </Pressable>
              )
            })}
            <View style={styles.listRow}>
              <Text style={styles.rowText}>Show drafts</Text>
              <Switch
                value={filters.showDrafts}
                onValueChange={(showDrafts) => onChange({ ...filters, showDrafts })}
                accessibilityLabel="Show drafts"
              />
            </View>
            <View style={styles.listRow}>
              <Text style={styles.rowText}>
                Hidden pull requests<Text style={styles.count}>{` · ${hiddenCount}`}</Text>
              </Text>
              <Switch
                value={filters.showHidden}
                onValueChange={(showHidden) => onChange({ ...filters, showHidden })}
                accessibilityLabel="Show hidden pull requests"
              />
            </View>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingTop: space.sm,
    paddingBottom: space.xl,
    maxHeight: '85%',
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderStrong,
    marginBottom: space.sm,
  },
  titleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
  },
  title: { ...type.heading, fontSize: 18, color: colors.text },
  reset: { fontFamily: fonts.display, fontSize: 15, color: colors.accent },
  body: { paddingHorizontal: space.lg, gap: space.sm },
  label: { ...type.label, color: colors.textDim, marginTop: space.sm },
  segment: { flexDirection: 'row', backgroundColor: colors.surfaceRaised, borderRadius: radius.sm, padding: 2 },
  segmentItem: { flex: 1, alignItems: 'center', paddingVertical: 6, borderRadius: radius.sm - 2 },
  segmentOn: { backgroundColor: colors.bg },
  segmentText: { ...type.bodySm, color: colors.textDim },
  segmentTextOn: { color: colors.text, fontFamily: fonts.display },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
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
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: HIT,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  repo: { fontFamily: fonts.mono, fontSize: 14, color: colors.text },
  rowText: { ...type.body, color: colors.text },
  count: { color: colors.textDim },
})
