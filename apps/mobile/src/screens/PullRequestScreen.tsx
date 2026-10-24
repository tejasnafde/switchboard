/**
 * One pull request: the header, a status card (checks expand in place,
 * failures first; reviews; conversations; conflicts), the review threads, the
 * description and the linked chats. "Work on PR" opens or starts a chat
 * (`WorkOnPrSheet`).
 *
 * With `pr_write_scope_v1` the threads are listed (`PrConversations`), and a
 * phone the desktop granted `pr-write` (read on every focus) may reply,
 * resolve, comment and review through `PrWriteSheet`. Merge, close,
 * reviewers and re-run stay on the desktop.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { createLogger } from '@shared/logger'
import { linkSourceLabel, type PrLinkChat } from '@shared/pull-request-links'
import { stripHtmlComments, type PrCheck, type PrConversation, type PrDetail } from '@shared/pull-requests'
import { PR_WRITE_SCOPE_CAPABILITY } from '@shared/pull-request-phone-writes'
import {
  checksStatus,
  checkTrailing,
  conflictsStatus,
  conversationsStatus,
  diffStatLabel,
  failedChecksPill,
  mergeOnDesktopNote,
  moreChecksLabel,
  orderedChecks,
  PHONE_CHECKS_SHOWN,
  prAgeLabel,
  RERUN_ON_DESKTOP_NOTE,
  reviewsStatus,
  type PhonePrStatusLine,
  type PhonePrTone,
  type PhoneReviewPill,
} from '@shared/pull-request-phone'
import { agentLabel, isAgentType } from '@shared/types'
import type { RootStackParamList } from '../../App'
import { colors, fonts, radius, space, type, HIT } from '../theme'
import { Markdown } from '../components/Markdown'
import { WorkOnPrSheet } from '../components/WorkOnPrSheet'
import { PrConversations } from '../components/PrConversations'
import { PrWriteSheet, type PrWriteSheetApi } from '../components/PrWriteSheet'
import { getClient, useConnectionsStore } from '../stores/connections'
import { openChatWithPill } from '../lib/pr-chat'
import { unlockToPost } from '../lib/device-unlock'
import { draftKey, newWriteId, type PrWriteTarget } from '../lib/pr-write'

const log = createLogger('screen:pull-request')

type Props = NativeStackScreenProps<RootStackParamList, 'PullRequest'>

const TONE: Record<PhonePrTone, string> = {
  failure: colors.red,
  pending: colors.amber,
  success: colors.green,
  dim: colors.textDim,
}

const CHECK_ICON: Record<
  PrCheck['state'],
  {
    name: 'close-circle-outline' | 'sync-outline' | 'checkmark-circle-outline' | 'remove-circle-outline'
    color: string
  }
> = {
  failure: { name: 'close-circle-outline', color: colors.red },
  pending: { name: 'sync-outline', color: colors.amber },
  success: { name: 'checkmark-circle-outline', color: colors.green },
  neutral: { name: 'remove-circle-outline', color: colors.textDim },
  skipped: { name: 'remove-circle-outline', color: colors.textDim },
}

const STATE_ICON: Record<PhonePrTone, keyof typeof Ionicons.glyphMap> = {
  failure: 'close-circle-outline',
  pending: 'sync-outline',
  success: 'checkmark-circle-outline',
  dim: 'remove-circle-outline',
}

function chatAgent(chat: PrLinkChat): string {
  return isAgentType(chat.agentType) ? agentLabel(chat.agentType) : chat.agentType
}

function StatusRow({
  icon,
  label,
  line,
  onPress,
  expanded,
}: {
  icon: keyof typeof Ionicons.glyphMap
  label: string
  line: PhonePrStatusLine
  onPress?: () => void
  expanded?: boolean
}) {
  const body = (
    <>
      <Ionicons name={icon} size={18} color={TONE[line.tone]} />
      <Text style={styles.statusLabel}>{label}</Text>
      <Text
        style={[styles.statusValue, { color: line.tone === 'failure' ? colors.red : colors.textDim }]}
        numberOfLines={1}
      >
        {line.text}
      </Text>
      {onPress && <Ionicons name={expanded ? 'chevron-down' : 'chevron-forward'} size={14} color={colors.textDim} />}
    </>
  )
  return onPress ? (
    <Pressable
      style={styles.statusRow}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      testID={`pr-status-${label.toLowerCase()}`}
    >
      {body}
    </Pressable>
  ) : (
    <View style={styles.statusRow} testID={`pr-status-${label.toLowerCase()}`}>
      {body}
    </View>
  )
}

export function PrDetailView({
  pr,
  chats,
  now,
  onOpenChat,
  onAskAboutFailures,
  onWorkOnPr,
  conversations,
  notice,
  canWrite = false,
}: {
  pr: PrDetail
  chats: PrLinkChat[]
  now: number
  onOpenChat: (chat: PrLinkChat) => void
  onAskAboutFailures: (pill: PhoneReviewPill) => void
  onWorkOnPr: () => void
  /** The review threads section, when the backend can list them for a phone. */
  conversations?: ReactNode
  /** A short confirmation after a write, such as "Posted". */
  notice?: string | null
  /** This phone holds `pr-write`, so the desktop note names only what stays there. */
  canWrite?: boolean
}) {
  const insets = useSafeAreaInsets()
  const [checksOpen, setChecksOpen] = useState(false)
  const [descriptionOpen, setDescriptionOpen] = useState(false)
  const checks = orderedChecks(pr.checkList)
  const shown = checks.slice(0, PHONE_CHECKS_SHOWN)
  const failedPill = failedChecksPill(pr)
  const description = stripHtmlComments(pr.description)
  const state = pr.draft && pr.state === 'open' ? 'Draft' : pr.state[0].toUpperCase() + pr.state.slice(1)
  const meta = [
    pr.author.displayName || pr.author.login,
    `updated ${prAgeLabel(pr.updatedAt, now)} ago`,
    diffStatLabel(pr),
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content} testID="pr-detail">
        <Text style={styles.title}>{pr.title}</Text>
        <View style={styles.line}>
          <View style={[styles.statePill, pr.state === 'open' && !pr.draft && styles.statePillOpen]}>
            <Text style={[styles.stateText, pr.state === 'open' && !pr.draft && styles.stateTextOpen]}>{state}</Text>
          </View>
          <Text style={styles.mono}>{`${pr.ref.owner}/${pr.ref.name} #${pr.ref.number}`}</Text>
        </View>
        <View style={styles.line}>
          <Ionicons name="git-branch-outline" size={14} color={colors.textDim} />
          <Text style={styles.branch} numberOfLines={1}>{`${pr.sourceBranch} → ${pr.targetBranch}`}</Text>
        </View>
        <Text style={styles.meta}>{meta}</Text>

        <View style={styles.card}>
          <StatusRow
            icon={STATE_ICON[checksStatus(pr.checks).tone]}
            label="Checks"
            line={checksStatus(pr.checks)}
            onPress={checks.length > 0 ? () => setChecksOpen((open) => !open) : undefined}
            expanded={checksOpen}
          />
          {checksOpen && (
            <View testID="pr-checks">
              {shown.map((check) => (
                <View key={check.id} style={styles.checkRow}>
                  <Ionicons name={CHECK_ICON[check.state].name} size={16} color={CHECK_ICON[check.state].color} />
                  <Text style={styles.checkName} numberOfLines={1}>
                    {check.name}
                  </Text>
                  <Text
                    style={[
                      styles.checkTrailing,
                      {
                        color:
                          TONE[check.state === 'failure' ? 'failure' : check.state === 'pending' ? 'pending' : 'dim'],
                      },
                    ]}
                  >
                    {checkTrailing(check)}
                  </Text>
                </View>
              ))}
              {checks.length > shown.length && (
                <Text style={styles.moreChecks}>{moreChecksLabel(checks.slice(PHONE_CHECKS_SHOWN))}</Text>
              )}
              {failedPill && (
                <Pressable
                  style={styles.askRow}
                  onPress={() => onAskAboutFailures(failedPill)}
                  accessibilityRole="button"
                  testID="pr-ask-failures"
                >
                  <Ionicons name="chatbox-outline" size={16} color={colors.accent} />
                  <Text style={styles.askText}>Ask the agent about the failures</Text>
                </Pressable>
              )}
              <View style={styles.lockRow}>
                <Ionicons name="lock-closed-outline" size={13} color={colors.textDim} />
                <Text style={styles.lockText}>{RERUN_ON_DESKTOP_NOTE}</Text>
              </View>
            </View>
          )}
          <StatusRow icon="eye-outline" label="Reviews" line={reviewsStatus(pr)} />
          <StatusRow icon="chatbox-outline" label="Conversations" line={conversationsStatus(pr)} />
          <StatusRow
            icon={pr.mergeConflicts ? 'warning-outline' : STATE_ICON[conflictsStatus(pr).tone]}
            label="Conflicts"
            line={conflictsStatus(pr)}
          />
        </View>

        <View style={styles.desktopNote} testID="pr-merge-on-desktop">
          <Ionicons name="lock-closed-outline" size={14} color={colors.textDim} style={styles.noteIcon} />
          <Text style={styles.noteText}>
            <Text style={styles.noteStrong}>Merge on desktop. </Text>
            {mergeOnDesktopNote(pr.ref.host, canWrite)}
          </Text>
        </View>

        {conversations}

        {description !== '' && (
          <>
            <Text style={styles.sectionLabel}>DESCRIPTION</Text>
            <View style={descriptionOpen ? undefined : styles.descriptionClamp}>
              <Markdown text={description} />
            </View>
            <Pressable onPress={() => setDescriptionOpen((open) => !open)} accessibilityRole="button" hitSlop={8}>
              <Text style={styles.link}>{descriptionOpen ? 'Show less' : 'Show more'}</Text>
            </Pressable>
          </>
        )}

        {chats.length > 0 && <Text style={styles.sectionLabel}>LINKED CHATS</Text>}
        {chats.map((chat) => (
          <Pressable key={chat.id} style={styles.chatRow} onPress={() => onOpenChat(chat)} accessibilityRole="button">
            <Ionicons name="chatbox-outline" size={18} color={colors.accent} />
            <View style={styles.chatBody}>
              <Text style={styles.chatTitle} numberOfLines={1}>
                {chat.title}
              </Text>
              <Text style={styles.chatMeta} numberOfLines={1}>
                {[chatAgent(chat), chat.linkSource ? linkSourceLabel(chat.linkSource).toLowerCase() : '']
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={14} color={colors.textDim} />
          </Pressable>
        ))}
      </ScrollView>
      {notice && (
        <View style={styles.notice} testID="pr-write-notice" accessibilityLiveRegion="polite">
          <Ionicons name="checkmark-circle-outline" size={16} color={colors.green} />
          <Text style={styles.noticeText}>{notice}</Text>
        </View>
      )}
      <View style={[styles.actions, { paddingBottom: Math.max(insets.bottom, space.md) }]}>
        <Pressable style={styles.primary} onPress={onWorkOnPr} accessibilityRole="button" testID="pr-work-on">
          <Ionicons name="chatbox-outline" size={18} color={colors.bg} />
          <Text style={styles.primaryText}>Work on PR</Text>
        </Pressable>
        <Pressable
          style={styles.browser}
          onPress={() => {
            void Linking.openURL(pr.url).catch((err: unknown) => log.warn('opening the pull request failed', err))
          }}
          accessibilityRole="link"
          accessibilityLabel="Open in browser"
          testID="pr-open-browser"
        >
          <Ionicons name="open-outline" size={20} color={colors.text} />
        </Pressable>
      </View>
    </View>
  )
}

export default function PullRequestScreen({ route, navigation }: Props) {
  const { connectionId } = route.params
  const { host, owner, name, number } = route.params.ref
  // Params are a fresh object per navigation; the fields name the PR.
  const ref = useMemo(() => ({ host, owner, name, number }), [host, owner, name, number])
  const [pr, setPr] = useState<PrDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [chats, setChats] = useState<PrLinkChat[]>([])
  const [sheet, setSheet] = useState<{ attachOnly: PhoneReviewPill } | 'work' | null>(null)
  const ticket = useRef(0)
  const [conversations, setConversations] = useState<PrConversation[] | null>(null)
  const [conversationsError, setConversationsError] = useState<string | null>(null)
  const [canWrite, setCanWrite] = useState(false)
  const [writeTarget, setWriteTarget] = useState<PrWriteTarget | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState<string | null>(null)
  const conversationsTicket = useRef(0)
  const scopesTicket = useRef(0)
  // Re-read on every render: the capability arrives with the `ready` frame, after the first paint.
  const writeCapable = getClient(connectionId)?.supportsCapability(PR_WRITE_SCOPE_CAPABILITY) === true
  const connected = useConnectionsStore((s) => s.status[connectionId] === 'connected')

  const loadConversations = useCallback(() => {
    const client = getClient(connectionId)
    if (!client || client.supportsCapability(PR_WRITE_SCOPE_CAPABILITY) !== true) return
    const mine = ++conversationsTicket.current
    client
      .pullRequestConversations(ref)
      .then((result) => {
        if (mine !== conversationsTicket.current) return
        if (result.ok) {
          setConversations(result.data)
          setConversationsError(null)
        } else setConversationsError(result.error.message)
      })
      .catch((err: unknown) => {
        log.warn('pull request conversations failed', err)
        if (mine === conversationsTicket.current)
          setConversationsError(err instanceof Error ? err.message : String(err))
      })
  }, [connectionId, ref])

  // The desktop grants and removes `pr-write` at any time, so the scope is read on every focus.
  const loadScopes = useCallback(() => {
    const client = getClient(connectionId)
    if (!client || client.supportsCapability(PR_WRITE_SCOPE_CAPABILITY) !== true) {
      setCanWrite(false)
      return
    }
    const mine = ++scopesTicket.current
    client
      .deviceScopes()
      .then((scopes) => {
        if (mine === scopesTicket.current) setCanWrite(Array.isArray(scopes) && scopes.includes('pr-write'))
      })
      .catch((err: unknown) => {
        log.warn('device scopes read failed', err)
        if (mine === scopesTicket.current) setCanWrite(false)
      })
  }, [connectionId])

  useEffect(() => {
    loadScopes()
    return navigation.addListener('focus', () => {
      loadScopes()
      loadConversations()
    })
  }, [navigation, loadScopes, loadConversations])

  // A capability that arrives after the first paint (a reconnect) still shows the threads.
  useEffect(() => {
    if (!writeCapable || !connected) return
    loadScopes()
    loadConversations()
  }, [writeCapable, connected, loadScopes, loadConversations])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 3000)
    return () => clearTimeout(timer)
  }, [notice])

  const writeApi = useMemo<PrWriteSheetApi>(
    () => ({
      writeAccount: (target) => {
        const client = getClient(connectionId)
        return client ? client.pullRequestWriteAccount(target) : Promise.reject(new Error('Backend not connected.'))
      },
      write: (channel, target, input) => {
        const client = getClient(connectionId)
        return client
          ? client.pullRequestWrite(channel, target, input)
          : Promise.reject(new Error('Backend not connected.'))
      },
      unlock: unlockToPost,
      newWriteId,
      isConnected: () => useConnectionsStore.getState().status[connectionId] === 'connected',
    }),
    [connectionId],
  )

  const load = useCallback(() => {
    const client = getClient(connectionId)
    if (!client) {
      setError('Backend not connected yet.')
      return
    }
    const mine = ++ticket.current
    setError(null)
    loadConversations()
    client
      .pullRequestDetail(ref)
      .then((result) => {
        if (mine !== ticket.current) return
        if (result.ok) setPr(result.data)
        else setError(result.error.message)
      })
      .catch((err: unknown) => {
        log.warn('pull request detail failed', err)
        if (mine === ticket.current) setError(err instanceof Error ? err.message : String(err))
      })
    client
      .pullRequestChats(ref)
      .then((list) => {
        if (mine === ticket.current) setChats(list)
      })
      .catch((err: unknown) => log.warn('linked chats failed', err))
  }, [connectionId, ref, loadConversations])

  useEffect(() => {
    load()
    const client = getClient(connectionId)
    return client?.onPullRequestLinksChanged(() => {
      client
        .pullRequestChats(ref)
        .then(setChats)
        .catch((err: unknown) => log.warn('linked chats failed', err))
    })
  }, [connectionId, load, ref])

  if (!pr) {
    return (
      <View style={styles.center}>
        {error ? (
          <>
            <Text style={styles.errorText}>{error}</Text>
            <Pressable onPress={load} accessibilityRole="button" hitSlop={8}>
              <Text style={styles.link}>Try again</Text>
            </Pressable>
          </>
        ) : (
          <ActivityIndicator color={colors.accent} />
        )}
      </View>
    )
  }

  const openChat = (chat: PrLinkChat, pill?: PhoneReviewPill) => {
    setSheet(null)
    openChatWithPill(navigation, connectionId, chat, pill)
  }

  return (
    <>
      <PrDetailView
        pr={pr}
        chats={chats}
        now={Date.now()}
        onOpenChat={(chat) => openChat(chat)}
        onAskAboutFailures={(pill) => (chats.length === 1 ? openChat(chats[0], pill) : setSheet({ attachOnly: pill }))}
        onWorkOnPr={() => setSheet('work')}
        notice={notice}
        canWrite={writeCapable && canWrite}
        conversations={
          writeCapable ? (
            <PrConversations
              conversations={conversations}
              error={conversationsError}
              canWrite={canWrite}
              onReply={(conversation) => setWriteTarget({ action: 'reply', conversation })}
              onResolve={(conversation) => setWriteTarget({ action: 'resolve', conversation })}
              onComment={() => setWriteTarget({ action: 'comment' })}
              onReview={() => setWriteTarget({ action: 'review' })}
            />
          ) : undefined
        }
      />
      {writeTarget && (
        <PrWriteSheet
          pr={pr}
          target={writeTarget}
          draft={drafts[draftKey(writeTarget)] ?? ''}
          onDraftChange={(text) => setDrafts((d) => ({ ...d, [draftKey(writeTarget)]: text }))}
          api={writeApi}
          onPosted={(note) => {
            setDrafts((d) => ({ ...d, [draftKey(writeTarget)]: '' }))
            setWriteTarget(null)
            setNotice(note)
            load()
          }}
          onRemoved={() => {
            // The sheet stays open with the removed note; the buttons go now, the re-read confirms.
            setCanWrite(false)
            loadScopes()
          }}
          onCheckThread={() => {
            setWriteTarget(null)
            loadConversations()
          }}
          onClose={() => setWriteTarget(null)}
        />
      )}
      {sheet && (
        <WorkOnPrSheet
          connectionId={connectionId}
          pr={pr}
          linkedChats={chats}
          attachOnly={sheet === 'work' ? undefined : sheet.attachOnly}
          onOpenChat={openChat}
          onStartChat={(projectPath) => {
            setSheet(null)
            navigation.navigate('NewSession', {
              connectionId,
              projectPath,
              projectName: projectPath.split('/').filter(Boolean).at(-1) ?? projectPath,
              pullRequest: pr,
            })
          }}
          onClose={() => setSheet(null)}
        />
      )}
    </>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.lg, gap: space.sm, paddingBottom: space.xxl },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md, padding: space.xl },
  errorText: { ...type.bodySm, color: colors.textDim, textAlign: 'center' },
  title: { ...type.title, fontSize: 22, lineHeight: 27, color: colors.text },
  line: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  statePill: {
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    backgroundColor: colors.surfaceRaised,
  },
  statePillOpen: { backgroundColor: 'rgba(63,185,80,0.15)' },
  stateText: { fontFamily: fonts.display, fontSize: 13, color: colors.textDim },
  stateTextOpen: { color: colors.green },
  mono: { fontFamily: fonts.mono, fontSize: 13, color: colors.textDim },
  branch: { fontFamily: fonts.mono, fontSize: 13, color: colors.text, flexShrink: 1 },
  meta: { ...type.bodySm, color: colors.textDim },
  card: {
    marginTop: space.sm,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: HIT,
    paddingHorizontal: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  statusLabel: { ...type.body, color: colors.text, flex: 1 },
  statusValue: { ...type.bodySm, flexShrink: 1 },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 36,
    paddingLeft: space.xl,
    paddingRight: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  checkName: { ...type.bodySm, color: colors.text, flex: 1 },
  checkTrailing: { ...type.monoSm },
  moreChecks: { ...type.bodySm, color: colors.textDim, paddingLeft: space.xl, paddingVertical: space.sm },
  askRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    minHeight: HIT,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  askText: { fontFamily: fonts.display, fontSize: 15, color: colors.accent },
  lockRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  lockText: { ...type.bodySm, color: colors.textDim },
  desktopNote: {
    flexDirection: 'row',
    gap: space.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.borderStrong,
    padding: space.md,
    marginTop: space.sm,
  },
  noteIcon: { marginTop: 3 },
  noteText: { ...type.bodySm, color: colors.textDim, flex: 1 },
  noteStrong: { fontFamily: fonts.display, color: colors.text },
  sectionLabel: { ...type.label, color: colors.textDim, marginTop: space.lg },
  descriptionClamp: { maxHeight: 96, overflow: 'hidden' },
  link: { fontFamily: fonts.display, fontSize: 14, color: colors.accent },
  chatRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
    padding: space.md,
  },
  chatBody: { flex: 1 },
  chatTitle: { ...type.body, color: colors.text },
  chatMeta: { ...type.monoSm, color: colors.textDim },
  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginHorizontal: space.lg,
    marginBottom: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceRaised,
  },
  noticeText: { ...type.bodySm, color: colors.text },
  actions: {
    flexDirection: 'row',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    backgroundColor: colors.bg,
  },
  primary: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    minHeight: HIT + 4,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
  },
  primaryText: { fontFamily: fonts.displayBold, fontSize: 16, color: colors.bg },
  browser: {
    width: HIT + 4,
    height: HIT + 4,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
