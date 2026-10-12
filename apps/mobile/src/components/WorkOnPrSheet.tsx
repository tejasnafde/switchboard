/**
 * "Work on PR": open a linked chat, start a chat on the PR's branch, or
 * attach the PR as a review pill to another chat. With `attachOnly` (Ask the
 * agent about the failures) it only picks a chat for that pill. Every choice
 * is a chat action; nothing here reaches the host.
 */
import { useEffect, useState } from 'react'
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { createLogger } from '@shared/logger'
import type { PrLinkChat } from '@shared/pull-request-links'
import type { PrDetail } from '@shared/pull-requests'
import { WORK_ON_PR_CAPABILITY, workOnPrCheckout, workOnPrPill, type PhoneReviewPill } from '@shared/pull-request-phone'
import { agentLabel, isAgentType } from '@shared/types'
import { colors, fonts, radius, space, type, HIT } from '../theme'
import { getClient } from '../stores/connections'

const log = createLogger('screen:work-on-pr')

function projectName(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

function Row({
  title,
  detail,
  onPress,
  disabled,
  testID,
}: {
  title: React.ReactNode
  detail: string
  onPress: () => void
  disabled?: boolean
  testID?: string
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.pressed, disabled && styles.disabled]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      testID={testID}
    >
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.rowDetail} numberOfLines={2}>
          {detail}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={14} color={colors.textDim} />
    </Pressable>
  )
}

export function WorkOnPrSheet({
  connectionId,
  pr,
  linkedChats,
  attachOnly,
  onOpenChat,
  onStartChat,
  onClose,
}: {
  connectionId: string
  pr: PrDetail
  linkedChats: PrLinkChat[]
  attachOnly?: PhoneReviewPill
  onOpenChat: (chat: PrLinkChat, pill?: PhoneReviewPill) => void
  onStartChat: (projectPath: string) => void
  onClose: () => void
}) {
  const [picking, setPicking] = useState(attachOnly !== undefined)
  const [others, setOthers] = useState<PrLinkChat[] | null>(null)
  const client = getClient(connectionId)
  const onBranch = client?.supportsCapability(WORK_ON_PR_CAPABILITY) === true && workOnPrCheckout(pr) !== null
  const project = pr.projectPaths[0]

  useEffect(() => {
    if (!picking || !client) return
    let current = true
    client
      .linkablePullRequestChats(pr.ref)
      .then((chats) => {
        if (current) setOthers(chats)
      })
      .catch((err: unknown) => {
        log.warn('listing chats for the pull request failed', err)
        if (current) setOthers([])
      })
    return () => {
      current = false
    }
  }, [picking, client, pr.ref])

  const chatDetail = (chat: PrLinkChat) =>
    [isAgentType(chat.agentType) ? agentLabel(chat.agentType) : chat.agentType, projectName(chat.projectPath)].join(
      ' · ',
    )
  const pill = attachOnly ?? workOnPrPill(pr, 'attached')
  const linkedIds = new Set(linkedChats.map((c) => c.id))
  const pickable = [...linkedChats, ...(others ?? []).filter((c) => !linkedIds.has(c.id))]

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()} testID="work-on-pr-sheet">
          <View style={styles.grabber} />
          <Text style={styles.title}>{picking ? 'Attach to a chat' : `Work on #${pr.ref.number}`}</Text>
          <ScrollView>
            {picking ? (
              <>
                <Text style={styles.label}>{`ADDS ${pill.label.toUpperCase()}`}</Text>
                {others === null && <ActivityIndicator color={colors.accent} style={styles.loading} />}
                {others !== null && pickable.length === 0 && (
                  <Text style={styles.empty}>No chats in this pull request's projects yet.</Text>
                )}
                {pickable.map((chat) => (
                  <Row
                    key={chat.id}
                    title={chat.title}
                    detail={chatDetail(chat)}
                    onPress={() => onOpenChat(chat, pill)}
                  />
                ))}
              </>
            ) : (
              <>
                {linkedChats.length > 0 && <Text style={styles.label}>LINKED CHAT</Text>}
                {linkedChats.map((chat) => (
                  <Row key={chat.id} title={chat.title} detail={chatDetail(chat)} onPress={() => onOpenChat(chat)} />
                ))}
                <Text style={styles.label}>NEW CHAT</Text>
                <Row
                  title={
                    <>
                      Start a chat on <Text style={styles.mono}>{pr.sourceBranch}</Text>
                    </>
                  }
                  detail={
                    !project
                      ? 'No project on this machine covers this repository.'
                      : onBranch
                        ? `In a worktree of ${projectName(project)} on the PR's branch.`
                        : `In ${projectName(project)}. The agent checks out the PR first.`
                  }
                  onPress={() => project && onStartChat(project)}
                  disabled={!project}
                  testID="work-on-pr-start"
                />
                <Row
                  title="Attach as context to another chat"
                  detail="Adds a review pill to its composer"
                  onPress={() => setPicking(true)}
                  testID="work-on-pr-attach"
                />
              </>
            )}
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
    maxHeight: '80%',
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderStrong,
    marginBottom: space.sm,
  },
  title: { ...type.heading, fontSize: 18, color: colors.text, paddingHorizontal: space.lg, paddingBottom: space.sm },
  label: {
    ...type.label,
    color: colors.textDim,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: HIT + 12,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  pressed: { backgroundColor: colors.wash },
  disabled: { opacity: 0.5 },
  rowBody: { flex: 1, gap: 2 },
  rowTitle: { ...type.body, color: colors.text },
  rowDetail: { ...type.bodySm, color: colors.textDim },
  mono: { fontFamily: fonts.mono, fontSize: 14 },
  loading: { padding: space.lg },
  empty: { ...type.bodySm, color: colors.textDim, paddingHorizontal: space.lg, paddingVertical: space.md },
})
