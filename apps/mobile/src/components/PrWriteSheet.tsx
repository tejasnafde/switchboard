/**
 * One pull request write from the phone: the composer, then the confirm
 * sheet that shows the account, the pull request, the thread and the exact
 * text, then Face ID or the passcode, then one send.
 *
 * The text is trimmed once, when the sheet opens, and that string is both
 * what the sheet shows and what is sent and digested. Every Post mints a new
 * write id. Nothing is queued, retried or re-sent: a send that throws is
 * either the scope removed ('not permitted') or "Not sure it posted", and
 * that sheet offers only Check thread.
 */
import { useEffect, useRef, useState } from 'react'
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { createLogger } from '@shared/logger'
import { PHONE_PR_WRITE_COPY, prTextLimitNote } from '@shared/pull-request-phone-writes'
import { REVIEW_EVENT_LABEL, type PrWriteDone, type ReviewEvent } from '@shared/pull-request-writes'
import type { PrDetail, PrRef, PrResult } from '@shared/pull-requests'
import { colors, fonts, radius, space, type, HIT } from '../theme'
import type { DeviceUnlock } from '../lib/device-unlock'
import {
  buildWriteRequest,
  classifyRejectedWrite,
  composeProblem,
  phoneReviewEvents,
  postedNote,
  postLabel,
  sheetTitle,
  threadLocation,
  type PrWriteTarget,
} from '../lib/pr-write'

const log = createLogger('screen:pr-write')

export interface PrWriteSheetApi {
  writeAccount(ref: PrRef): Promise<PrResult<{ account: string }>>
  write(channel: string, ref: PrRef, input: Record<string, unknown>): Promise<PrResult<PrWriteDone>>
  unlock(): Promise<DeviceUnlock>
  newWriteId(): string
  isConnected(): boolean
}

type Account = { kind: 'loading' } | { kind: 'ready'; account: string } | { kind: 'failed'; message: string }

type Banner =
  | { kind: 'refused'; message: string }
  | { kind: 'removed' }
  | { kind: 'no-passcode' }
  | { kind: 'unavailable' }
  | { kind: 'offline' }

const UNLOCK_UNAVAILABLE = 'This phone cannot ask for Face ID or its passcode. Nothing was sent.'
const OFFLINE = 'Not connected to the computer. Nothing was sent.'
const VERDICT_GONE = 'This verdict is not open now. Pick another.'

const count = (n: number) => `${n.toLocaleString('en-US')} ${n === 1 ? 'character' : 'characters'}`

function bannerText(banner: Banner): string {
  if (banner.kind === 'refused') return banner.message
  if (banner.kind === 'removed') return PHONE_PR_WRITE_COPY.removed
  if (banner.kind === 'no-passcode') return PHONE_PR_WRITE_COPY.noPasscode
  if (banner.kind === 'unavailable') return UNLOCK_UNAVAILABLE
  return OFFLINE
}

function composeTitle(target: PrWriteTarget): string {
  if (target.action === 'reply') {
    const last = target.conversation.comments.at(-1)
    return last ? `Reply to ${last.author.login || last.author.displayName}` : 'Reply'
  }
  return target.action === 'comment' ? 'Comment on the pull request' : 'Review'
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.fact}>
      <Text style={styles.factKey}>{label}</Text>
      <View style={styles.factValue}>{children}</View>
    </View>
  )
}

export function PrWriteSheet({
  pr,
  target,
  draft,
  onDraftChange,
  api,
  onPosted,
  onRemoved,
  onCheckThread,
  onClose,
}: {
  pr: PrDetail
  target: PrWriteTarget
  draft: string
  onDraftChange: (text: string) => void
  api: PrWriteSheetApi
  /** The host took the write: close, clear the draft, show `note`, re-read the pull request. */
  onPosted: (note: string) => void
  /** The backend refused the channel: the desktop removed `pr-write`. */
  onRemoved: () => void
  /** After "Not sure it posted": re-read the threads and close. */
  onCheckThread: () => void
  onClose: () => void
}) {
  const host = pr.ref.host
  const events = phoneReviewEvents(pr)
  const [step, setStep] = useState<'compose' | 'confirm'>(target.action === 'resolve' ? 'confirm' : 'compose')
  const [event, setEvent] = useState<ReviewEvent>(events[0] ?? 'comment')
  const [shown, setShown] = useState('')
  const [account, setAccount] = useState<Account>({ kind: 'loading' })
  const [phase, setPhase] = useState<'idle' | 'unlocking' | 'posting'>('idle')
  const [banner, setBanner] = useState<Banner | null>(null)
  const [uncertain, setUncertain] = useState(false)
  const mounted = useRef(true)
  // Set synchronously on the first Post tap, so a second tap before the re-render sends nothing.
  const sending = useRef(false)
  useEffect(
    () => () => {
      mounted.current = false
    },
    [],
  )

  const action = target.action
  const reviewEvent = action === 'review' ? event : null
  const conversation = action === 'reply' || action === 'resolve' ? target.conversation : null

  // A re-read of the pull request gives a new `pr` object; the account belongs to the ref's fields.
  const { host: refHost, owner, name, number } = pr.ref
  useEffect(() => {
    if (step !== 'confirm') return
    let current = true
    setAccount({ kind: 'loading' })
    api
      .writeAccount({ host: refHost, owner, name, number })
      .then((result) => {
        if (!current) return
        setAccount(
          result.ok
            ? { kind: 'ready', account: result.data.account }
            : { kind: 'failed', message: result.error.message },
        )
      })
      .catch((err: unknown) => {
        log.warn('write account read failed', err)
        if (current) setAccount({ kind: 'failed', message: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      current = false
    }
  }, [api, refHost, owner, name, number, step])

  // A re-read of the pull request while the sheet is open can close it or change the viewer.
  const verdictAllowed = reviewEvent === null || events.includes(reviewEvent)
  const draftProblem = verdictAllowed ? composeProblem(host, action, reviewEvent, draft) : VERDICT_GONE
  const limitNote = prTextLimitNote(host, draft.trim().length)
  const removed = banner?.kind === 'removed'
  const busy = phase !== 'idle'
  const canPost =
    account.kind === 'ready' &&
    !busy &&
    !removed &&
    verdictAllowed &&
    composeProblem(host, action, reviewEvent, shown) === null

  const openConfirm = () => {
    if (draftProblem) return
    setShown(draft.trim())
    setBanner(null)
    setStep('confirm')
  }

  const post = async () => {
    if (sending.current || !canPost || account.kind !== 'ready') return
    sending.current = true
    try {
      await postOnce(account.account)
    } finally {
      sending.current = false
    }
  }

  const postOnce = async (writeAccount: string) => {
    setBanner(null)
    if (!api.isConnected()) {
      setBanner({ kind: 'offline' })
      return
    }
    setPhase('unlocking')
    const unlock = await api.unlock()
    if (!mounted.current) return
    if (unlock !== 'ok') {
      setPhase('idle')
      if (unlock === 'no-passcode') setBanner({ kind: 'no-passcode' })
      else if (unlock === 'unavailable') setBanner({ kind: 'unavailable' })
      return
    }
    if (!api.isConnected()) {
      setPhase('idle')
      setBanner({ kind: 'offline' })
      return
    }
    const request = buildWriteRequest({
      account: writeAccount,
      ref: pr.ref,
      target,
      event: reviewEvent,
      text: shown,
      writeId: api.newWriteId(),
    })
    setPhase('posting')
    let result: PrResult<PrWriteDone>
    try {
      result = await api.write(request.channel, pr.ref, request.input)
    } catch (err) {
      const kind = classifyRejectedWrite(err)
      log.warn(`pull request ${action} send failed (${kind})`, err)
      if (!mounted.current) return
      setPhase('idle')
      if (kind === 'removed') {
        setBanner({ kind: 'removed' })
        onRemoved()
      } else {
        setUncertain(true)
      }
      return
    }
    if (!mounted.current) return
    setPhase('idle')
    if (result.ok) {
      onPosted(postedNote(action, reviewEvent))
      return
    }
    log.info(`pull request ${action} refused`, { kind: result.error.kind })
    setBanner({ kind: 'refused', message: result.error.message })
  }

  const close = () => {
    if (busy) return
    if (uncertain) onCheckThread()
    else onClose()
  }

  const facts = (
    <>
      <Fact label="Account">
        {account.kind === 'ready' && <Text style={styles.factText}>{account.account}</Text>}
        {account.kind === 'loading' && <Text style={styles.factDim}>Reading the account…</Text>}
        {account.kind === 'failed' && <Text style={styles.factError}>{account.message}</Text>}
      </Fact>
      <Fact label="Pull request">
        <Text style={styles.factText}>{`${pr.ref.owner}/${pr.ref.name} #${pr.ref.number}`}</Text>
        <Text style={styles.factDim}>{pr.title}</Text>
      </Fact>
      {conversation && (
        <Fact label="Thread">
          <Text style={styles.factMono}>{threadLocation(conversation)}</Text>
          {conversation.comments.length > 0 && (
            <Text style={styles.quote} numberOfLines={3}>
              {conversation.comments[conversation.comments.length - 1].body}
            </Text>
          )}
        </Fact>
      )}
    </>
  )

  const textBlock = (label: string) => (
    <>
      <View style={styles.textCap}>
        <Text style={styles.factKey}>{label}</Text>
        <Text style={styles.factDim}>{count(shown.length)}</Text>
      </View>
      <ScrollView style={styles.exact} testID="pr-write-exact">
        {shown ? <Text style={styles.exactText}>{shown}</Text> : <Text style={styles.factDim}>No text</Text>}
      </ScrollView>
    </>
  )

  let body: React.ReactNode
  if (uncertain) {
    body = (
      <>
        <Text style={styles.title}>{PHONE_PR_WRITE_COPY.notSureTitle}</Text>
        <View style={[styles.banner, styles.bannerWarn]}>
          <Ionicons name="warning-outline" size={16} color={colors.amber} />
          <Text style={styles.bannerText}>{PHONE_PR_WRITE_COPY.notSureBody}</Text>
        </View>
        {facts}
        {action !== 'resolve' && textBlock('Your text, kept')}
        <View style={styles.buttons}>
          <Pressable
            onPress={onCheckThread}
            accessibilityRole="button"
            testID="pr-write-check-thread"
            style={[styles.button, styles.primary, styles.flex]}
          >
            <Text style={[styles.buttonText, styles.primaryText]}>Check thread</Text>
          </Pressable>
        </View>
      </>
    )
  } else if (step === 'compose') {
    const showProblem = action === 'review' && draftProblem && !limitNote
    body = (
      <>
        <Text style={styles.title}>{composeTitle(target)}</Text>
        {conversation && (
          <Text style={styles.factMono} numberOfLines={1}>
            {threadLocation(conversation)}
          </Text>
        )}
        {action === 'review' && (
          <View style={styles.chips}>
            {events.map((e) => (
              <Pressable
                key={e}
                onPress={() => setEvent(e)}
                accessibilityRole="button"
                accessibilityState={{ selected: e === event }}
                testID={`pr-verdict-${e}`}
                style={[styles.chip, e === event && styles.chipOn]}
              >
                <Text style={[styles.chipText, e === event && styles.chipTextOn]}>{REVIEW_EVENT_LABEL[e]}</Text>
              </Pressable>
            ))}
          </View>
        )}
        <TextInput
          value={draft}
          onChangeText={onDraftChange}
          multiline
          placeholder={action === 'review' ? 'Summary' : 'Write here'}
          placeholderTextColor={colors.textFaint}
          accessibilityLabel="Text"
          testID="pr-write-input"
          style={[styles.input, limitNote && styles.inputError]}
        />
        <Text style={styles.factDim}>{count(draft.trim().length)}</Text>
        {limitNote && (
          <Text style={styles.error} testID="pr-write-limit">
            {limitNote}
          </Text>
        )}
        {showProblem && <Text style={styles.factDim}>{draftProblem}</Text>}
        <View style={styles.buttons}>
          <Pressable onPress={onClose} accessibilityRole="button" style={styles.button}>
            <Text style={styles.buttonText}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={openConfirm}
            disabled={draftProblem !== null}
            accessibilityRole="button"
            accessibilityState={{ disabled: draftProblem !== null }}
            testID="pr-write-continue"
            style={[styles.button, styles.primary, styles.flex, draftProblem !== null && styles.disabled]}
          >
            <Text style={[styles.buttonText, styles.primaryText]}>Continue</Text>
          </Pressable>
        </View>
      </>
    )
  } else {
    body = (
      <>
        <Text style={styles.title}>{sheetTitle(action, reviewEvent)}</Text>
        {banner && (
          <View
            style={[styles.banner, banner.kind === 'no-passcode' ? styles.bannerWarn : styles.bannerError]}
            testID="pr-write-banner"
          >
            <Ionicons
              name={banner.kind === 'no-passcode' ? 'warning-outline' : 'alert-circle-outline'}
              size={16}
              color={banner.kind === 'no-passcode' ? colors.amber : colors.red}
            />
            <Text style={styles.bannerText} accessibilityLiveRegion="polite">
              {bannerText(banner)}
            </Text>
          </View>
        )}
        {facts}
        {action !== 'resolve' && textBlock('Text')}
        {reviewEvent === 'approve' && <Text style={styles.factDim}>{PHONE_PR_WRITE_COPY.approveNote}</Text>}
        {!verdictAllowed && <Text style={styles.error}>{VERDICT_GONE}</Text>}
        {!removed && (
          <View style={styles.lockLine}>
            <Ionicons name="lock-closed-outline" size={13} color={colors.textDim} />
            <Text style={styles.factDim}>Face ID or passcode before it posts</Text>
          </View>
        )}
        <View style={styles.buttons}>
          <Pressable
            onPress={close}
            disabled={busy}
            accessibilityRole="button"
            testID="pr-write-cancel"
            style={[styles.button, !removed && styles.flex, busy && styles.disabled]}
          >
            <Text style={styles.buttonText}>{removed ? 'Close' : 'Cancel'}</Text>
          </Pressable>
          {!removed && (
            <Pressable
              onPress={() => void post()}
              disabled={!canPost}
              accessibilityRole="button"
              accessibilityState={{ disabled: !canPost, busy }}
              testID="pr-write-post"
              style={[styles.button, styles.primary, styles.flex, !canPost && styles.disabled]}
            >
              <Text style={[styles.buttonText, styles.primaryText]}>
                {phase === 'posting' ? 'Posting…' : postLabel(action, reviewEvent)}
              </Text>
            </Pressable>
          )}
        </View>
      </>
    )
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={close}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={styles.backdrop} onPress={close}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()} testID="pr-write-sheet">
            <ScrollView contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled">
              {body}
            </ScrollView>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    maxHeight: '90%',
  },
  sheetContent: { paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.xl, gap: space.sm },
  title: { color: colors.text, ...type.heading },
  fact: {
    flexDirection: 'row',
    gap: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  factKey: { ...type.bodySm, color: colors.textDim, width: 96 },
  factValue: { flex: 1, gap: 2 },
  factText: { ...type.bodySm, color: colors.text },
  factMono: { fontFamily: fonts.mono, fontSize: 12, lineHeight: 18, color: colors.text },
  factDim: { ...type.bodySm, color: colors.textDim },
  factError: { ...type.bodySm, color: colors.red },
  quote: {
    ...type.bodySm,
    color: colors.textDim,
    borderLeftWidth: 2,
    borderLeftColor: colors.borderStrong,
    paddingLeft: space.sm,
  },
  textCap: { flexDirection: 'row', justifyContent: 'space-between', marginTop: space.xs },
  exact: {
    maxHeight: 200,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    padding: space.sm,
  },
  exactText: { ...type.bodySm, color: colors.text },
  lockLine: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  banner: { flexDirection: 'row', gap: space.sm, borderRadius: radius.sm, borderWidth: 1, padding: space.sm },
  bannerError: { borderColor: 'rgba(248,81,73,0.4)', backgroundColor: 'rgba(248,81,73,0.08)' },
  bannerWarn: { borderColor: 'rgba(210,153,34,0.4)', backgroundColor: 'rgba(210,153,34,0.08)' },
  bannerText: { ...type.bodySm, color: colors.text, flex: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    minHeight: 36,
    paddingHorizontal: space.md,
    justifyContent: 'center',
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  chipOn: { borderColor: colors.accent, backgroundColor: colors.accentWash },
  chipText: { fontFamily: fonts.display, fontSize: 14, color: colors.textDim },
  chipTextOn: { color: colors.accent },
  input: {
    minHeight: 120,
    maxHeight: 280,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceRaised,
    color: colors.text,
    padding: space.sm,
    textAlignVertical: 'top',
    ...type.bodySm,
  },
  inputError: { borderColor: colors.red },
  error: { color: colors.red, ...type.bodySm },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm, marginTop: space.xs },
  button: {
    minHeight: HIT,
    paddingHorizontal: space.lg,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surfaceRaised,
  },
  primary: { backgroundColor: colors.accent, borderColor: colors.accent },
  disabled: { opacity: 0.4 },
  buttonText: { color: colors.text, fontFamily: fonts.display, fontSize: 14 },
  primaryText: { color: colors.bg },
})
