/**
 * The review threads of a pull request on the phone. Read-only unless the
 * desktop granted this phone `pr-write`: then each open thread offers Reply
 * and Resolve, and the pull request offers Comment and Review. Without the
 * scope one note says what the phone can do and how to get more, with no
 * disabled buttons.
 */
import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { PHONE_PR_WRITE_COPY } from '@shared/pull-request-phone-writes'
import type { PrConversation } from '@shared/pull-requests'
import { colors, fonts, radius, space, type, HIT } from '../theme'
import { threadLocation } from '../lib/pr-write'

/** Comments shown in a collapsed thread: the newest ones. */
const COLLAPSED_COMMENTS = 3
/** Lines of one comment body in a collapsed thread. */
const COLLAPSED_LINES = 4

function ThreadCard({
  conversation,
  canWrite,
  onReply,
  onResolve,
}: {
  conversation: PrConversation
  canWrite: boolean
  onReply: () => void
  onResolve: () => void
}) {
  const [open, setOpen] = useState(false)
  const comments = open ? conversation.comments : conversation.comments.slice(-COLLAPSED_COMMENTS)
  const hidden = conversation.comments.length - comments.length
  const long = hidden > 0 || conversation.comments.some((c) => c.body.length > 280 || c.body.split('\n').length > 4)
  const state = [conversation.resolved && 'Resolved', conversation.outdated && 'Outdated'].filter(Boolean).join(' · ')

  return (
    <View style={styles.thread} testID={`pr-thread-${conversation.id}`}>
      <View style={styles.threadHead}>
        <Ionicons
          name={conversation.path ? 'document-text-outline' : 'chatbox-outline'}
          size={14}
          color={colors.textDim}
        />
        <Text style={styles.location} numberOfLines={1}>
          {threadLocation(conversation)}
        </Text>
        {state !== '' && <Text style={styles.state}>{state}</Text>}
      </View>
      {hidden > 0 && <Text style={styles.more}>{`${hidden} earlier ${hidden === 1 ? 'comment' : 'comments'}`}</Text>}
      {comments.map((comment) => (
        <View key={comment.id} style={styles.comment}>
          <Text style={styles.author}>{comment.author.login || comment.author.displayName}</Text>
          <Text style={styles.body} numberOfLines={open ? undefined : COLLAPSED_LINES}>
            {comment.body}
          </Text>
        </View>
      ))}
      {long && (
        <Pressable onPress={() => setOpen((v) => !v)} accessibilityRole="button" hitSlop={8}>
          <Text style={styles.link}>{open ? 'Show less' : 'Show all'}</Text>
        </Pressable>
      )}
      {canWrite && !conversation.resolved && (
        <View style={styles.row}>
          <Pressable
            style={styles.button}
            onPress={onReply}
            accessibilityRole="button"
            testID={`pr-reply-${conversation.id}`}
          >
            <Text style={styles.buttonText}>Reply</Text>
          </Pressable>
          <Pressable
            style={styles.button}
            onPress={onResolve}
            accessibilityRole="button"
            testID={`pr-resolve-${conversation.id}`}
          >
            <Text style={styles.buttonText}>Resolve</Text>
          </Pressable>
        </View>
      )}
    </View>
  )
}

export function PrConversations({
  conversations,
  error,
  canWrite,
  onReply,
  onResolve,
  onComment,
  onReview,
}: {
  conversations: PrConversation[] | null
  error: string | null
  canWrite: boolean
  onReply: (conversation: PrConversation) => void
  onResolve: (conversation: PrConversation) => void
  onComment: () => void
  onReview: () => void
}) {
  const open = conversations?.filter((c) => !c.resolved).length ?? 0
  return (
    <View style={styles.section} testID="pr-conversations">
      <Text style={styles.label}>CONVERSATIONS</Text>
      {conversations === null && <Text style={styles.dim}>{error ?? 'Reading threads…'}</Text>}
      {conversations !== null && conversations.length === 0 && <Text style={styles.dim}>No threads yet.</Text>}
      {conversations !== null && conversations.length > 0 && (
        <Text style={styles.dim}>{`${open} of ${conversations.length} open`}</Text>
      )}
      {conversations?.map((conversation) => (
        <ThreadCard
          key={conversation.id}
          conversation={conversation}
          canWrite={canWrite}
          onReply={() => onReply(conversation)}
          onResolve={() => onResolve(conversation)}
        />
      ))}
      {canWrite ? (
        <View style={styles.row}>
          <Pressable style={styles.button} onPress={onComment} accessibilityRole="button" testID="pr-comment">
            <Text style={styles.buttonText}>Comment</Text>
          </Pressable>
          <Pressable style={styles.button} onPress={onReview} accessibilityRole="button" testID="pr-review">
            <Text style={styles.buttonText}>Review</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.note} testID="pr-write-no-scope">
          <Ionicons name="lock-closed-outline" size={14} color={colors.textDim} style={styles.noteIcon} />
          <Text style={styles.noteText}>
            <Text style={styles.noteStrong}>{`${PHONE_PR_WRITE_COPY.noScopeTitle} `}</Text>
            {PHONE_PR_WRITE_COPY.noScopeBody}
          </Text>
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  section: { gap: space.sm, marginTop: space.lg },
  label: { ...type.label, color: colors.textDim },
  dim: { ...type.bodySm, color: colors.textDim },
  thread: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
    padding: space.md,
    gap: space.sm,
  },
  threadHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  location: { fontFamily: fonts.mono, fontSize: 12, color: colors.text, flex: 1 },
  state: { ...type.bodySm, color: colors.textDim },
  more: { ...type.bodySm, color: colors.textDim },
  comment: { gap: 2 },
  author: { fontFamily: fonts.display, fontSize: 13, color: colors.text },
  body: { ...type.bodySm, color: colors.text },
  link: { fontFamily: fonts.display, fontSize: 14, color: colors.accent },
  row: { flexDirection: 'row', gap: space.sm },
  button: {
    flex: 1,
    minHeight: HIT,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surfaceRaised,
  },
  buttonText: { fontFamily: fonts.display, fontSize: 14, color: colors.text },
  note: {
    flexDirection: 'row',
    gap: space.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.borderStrong,
    padding: space.md,
  },
  noteIcon: { marginTop: 3 },
  noteText: { ...type.bodySm, color: colors.textDim, flex: 1 },
  noteStrong: { fontFamily: fonts.display, color: colors.text },
})
