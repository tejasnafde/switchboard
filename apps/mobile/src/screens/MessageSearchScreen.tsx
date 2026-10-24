/**
 * Search every chat's saved messages on one machine (`app:search-messages`).
 * Same rules and copy as native Android's search screen: two characters
 * minimum, 200 ms debounce, at most 40 rows, a tap opens the chat.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { createLogger } from '@shared/logger'
import type { MessageSearchResult } from '@shared/message-search'
import type { RootStackParamList } from '../../App'
import { colors, fonts, radius, space, type, HIT } from '../theme'
import { getClient } from '../stores/connections'
import { messageSearchRow, searchableQuery, SEARCH_DEBOUNCE_MS, SEARCH_RESULT_LIMIT } from '../lib/message-search'

const log = createLogger('screen:message-search')

type Props = NativeStackScreenProps<RootStackParamList, 'MessageSearch'>

interface SearchState {
  results: MessageSearchResult[]
  loading: boolean
  searched: boolean
  error: string | null
}

const IDLE: SearchState = { results: [], loading: false, searched: false, error: null }

export default function MessageSearchScreen({ route, navigation }: Props) {
  const { connectionId } = route.params
  const [query, setQuery] = useState('')
  const [state, setState] = useState<SearchState>(IDLE)
  // Only the newest request may write results, so a slow answer to an older query is dropped.
  const request = useRef(0)

  const run = useCallback(
    (text: string) => {
      const token = ++request.current
      const client = getClient(connectionId)
      if (!client) {
        setState({ results: [], loading: false, searched: true, error: 'Backend not connected yet.' })
        return
      }
      setState((s) => ({ ...s, loading: true, searched: true, error: null }))
      client.searchMessages(text).then(
        (results) => {
          if (token !== request.current) return
          setState({ results: results.slice(0, SEARCH_RESULT_LIMIT), loading: false, searched: true, error: null })
        },
        (err: unknown) => {
          if (token !== request.current) return
          log.warn('search failed', err)
          setState({
            results: [],
            loading: false,
            searched: true,
            error: err instanceof Error ? err.message : String(err),
          })
        },
      )
    },
    [connectionId],
  )

  useEffect(() => {
    setState(IDLE)
    const text = searchableQuery(query)
    if (text === null) return
    const timer = setTimeout(() => run(text), SEARCH_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      request.current += 1
    }
  }, [query, run])

  const rows = useMemo(() => state.results.map(messageSearchRow), [state.results])
  const text = searchableQuery(query)

  let body
  if (state.error !== null) {
    body = (
      <View style={styles.center}>
        <Text style={styles.stateTitle}>Search unavailable</Text>
        <Text style={styles.stateDetail}>{state.error}</Text>
        <Pressable testID="search-retry" style={styles.retryButton} onPress={() => text !== null && run(text)}>
          <Text style={styles.retryLabel}>Retry</Text>
        </Pressable>
      </View>
    )
  } else if (text === null) {
    body = (
      <View style={styles.center}>
        <Text style={styles.stateTitle}>Search every chat</Text>
        <Text style={styles.stateDetail}>Enter at least two characters to search messages on this machine.</Text>
      </View>
    )
  } else if (state.searched && !state.loading && rows.length === 0) {
    body = (
      <View style={styles.center}>
        <Text style={styles.stateTitle}>No matches</Text>
        <Text style={styles.stateDetail}>No saved message contains “{text}”.</Text>
      </View>
    )
  } else {
    body = (
      <FlatList
        data={rows}
        keyExtractor={(row) => row.key}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        renderItem={({ item }) => (
          <Pressable
            testID={`search-row-${item.key}`}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() =>
              navigation.navigate('Thread', {
                connectionId,
                threadId: item.result.conversationId,
                title: item.title,
                projectPath: item.result.projectPath,
                worktreePath: item.result.worktreePath,
                worktreeBranch: item.result.worktreeBranch ?? undefined,
              })
            }
          >
            <Text style={styles.title} numberOfLines={1}>
              {item.title}
            </Text>
            {item.snippet !== '' && (
              <Text style={styles.snippet} numberOfLines={3}>
                {item.snippet}
              </Text>
            )}
            <Text style={styles.metadata} numberOfLines={1}>
              {item.metadata}
            </Text>
          </Pressable>
        )}
      />
    )
  }

  return (
    <View style={styles.screen}>
      <View style={styles.searchWrap}>
        <TextInput
          style={styles.searchInput}
          value={query}
          onChangeText={setQuery}
          placeholder="Search messages"
          placeholderTextColor={colors.textFaint}
          accessibilityLabel="Search messages"
          autoFocus
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          clearButtonMode="while-editing"
        />
        {state.loading && <ActivityIndicator style={styles.spinner} color={colors.textDim} />}
      </View>
      {body}
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  searchInput: {
    flex: 1,
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.sm,
    color: colors.text,
    paddingHorizontal: space.md,
    minHeight: HIT,
    ...type.body,
  },
  spinner: { marginRight: space.xs },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
    gap: space.sm,
  },
  stateTitle: { ...type.heading, color: colors.text },
  stateDetail: { ...type.bodySm, color: colors.textDim, textAlign: 'center' },
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
  retryLabel: { fontFamily: fonts.display, fontSize: 15, color: colors.accent },
  row: {
    minHeight: HIT,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    gap: space.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowPressed: { backgroundColor: colors.surface },
  title: { ...type.heading, color: colors.text },
  snippet: { ...type.bodySm, color: colors.textDim },
  metadata: { ...type.monoSm, color: colors.textFaint },
})
