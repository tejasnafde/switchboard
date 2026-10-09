/**
 * Send a fork's work back to its parent chat (`shared/merge-back.ts`), or edit
 * the summary card waiting in the parent. The backend builds the summary; the
 * user reads and edits it here. Port of the desktop's MergeBackDialog.
 */
import React, { useEffect, useState } from 'react'
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import {
  mergeBackPreviewNote,
  type MergeBackActionResult,
  type MergeBackPreview,
  type MergeBackToken,
} from '@shared/merge-back'
import { createLogger } from '@shared/logger'
import { colors, fonts, radius, space, type, HIT } from '../theme'

const log = createLogger('screen:merge-back')

export type MergeBackSheetMode =
  | { kind: 'send'; forkThreadId: string; parentTitle: string }
  | { kind: 'edit'; parentThreadId: string; mergeBackId: string; forkTitle: string; text: string }

export interface MergeBackSheetApi {
  preview(forkThreadId: string): Promise<MergeBackPreview>
  send(forkThreadId: string, text: string, token: MergeBackToken): Promise<MergeBackActionResult>
  edit(parentThreadId: string, id: string, text: string): Promise<MergeBackActionResult>
}

type Load =
  | { kind: 'loading' }
  | { kind: 'ready'; token: MergeBackToken | null; replacesPending: boolean; note: string | null }
  | { kind: 'blocked'; message: string }

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function MergeBackSheet({ mode, api, onClose }: { mode: MergeBackSheetMode; api: MergeBackSheetApi; onClose: () => void }) {
  const [load, setLoad] = useState<Load>(() => mode.kind === 'edit'
    ? { kind: 'ready', token: null, replacesPending: false, note: null }
    : { kind: 'loading' })
  const [text, setText] = useState(mode.kind === 'edit' ? mode.text : '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const forkThreadId = mode.kind === 'send' ? mode.forkThreadId : null

  useEffect(() => {
    if (!forkThreadId) return
    // The sheet can close (or open for another fork) before the preview lands.
    let current = true
    api.preview(forkThreadId).then((preview) => {
      if (!current) return
      if (preview.status !== 'ready') {
        setLoad({ kind: 'blocked', message: preview.message })
        return
      }
      setText(preview.text)
      setLoad({ kind: 'ready', token: preview.token, replacesPending: preview.replacesPending, note: mergeBackPreviewNote(preview) })
    }).catch((err: unknown) => {
      log.warn('merge-back preview failed', err)
      if (current) setLoad({ kind: 'blocked', message: errorText(err) })
    })
    return () => { current = false }
  }, [api, forkThreadId])

  const submit = async () => {
    if (load.kind !== 'ready' || saving || !text.trim()) return
    setSaving(true)
    setError(null)
    try {
      let result: MergeBackActionResult
      if (mode.kind === 'send') {
        if (!load.token) return
        result = await api.send(mode.forkThreadId, text, load.token)
      } else {
        result = await api.edit(mode.parentThreadId, mode.mergeBackId, text)
      }
      if (result.ok) onClose()
      else setError(result.message)
    } catch (err) {
      log.warn(`merge-back ${mode.kind} failed`, err)
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  // A send in flight cannot be called back, so the sheet stays until it settles.
  const close = () => { if (!saving) onClose() }
  const title = mode.kind === 'send'
    ? `Send back to "${mode.parentTitle}"`
    : `Edit the summary from fork "${mode.forkTitle}"`
  const canSubmit = load.kind === 'ready' && !saving && text.trim().length > 0

  return (
    <Modal visible transparent animationType="fade" onRequestClose={close}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={styles.backdrop} onPress={close}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()} testID="merge-back-sheet">
            <Text style={styles.title}>{title}</Text>
            <Text style={styles.note}>
              {mode.kind === 'send'
                ? 'The parent chat keeps this summary and gives it to its agent with your next message there, as context. Nothing is merged in git.'
                : 'This goes to the agent with your next message in this chat.'}
            </Text>
            {load.kind === 'loading' && <Text style={styles.note}>Building the summary…</Text>}
            {load.kind === 'blocked' && <Text style={styles.body} accessibilityLiveRegion="polite">{load.message}</Text>}
            {load.kind === 'ready' && (
              <>
                {load.note && <Text style={styles.note}>{load.note}</Text>}
                {load.replacesPending && (
                  <Text style={styles.body}>A summary from this fork is already waiting in the parent. Sending replaces it.</Text>
                )}
                <TextInput
                  value={text}
                  onChangeText={setText}
                  multiline
                  editable={!saving}
                  accessibilityLabel="Summary"
                  testID="merge-back-text"
                  style={styles.input}
                />
                {error && <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text>}
              </>
            )}
            <View style={styles.buttons}>
              <Pressable onPress={close} disabled={saving} accessibilityRole="button" style={[styles.button, saving && styles.disabled]}>
                <Text style={styles.buttonText}>Cancel</Text>
              </Pressable>
              {load.kind === 'ready' && (
                <Pressable
                  onPress={() => void submit()}
                  disabled={!canSubmit}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: !canSubmit }}
                  testID="merge-back-submit"
                  style={[styles.button, styles.primary, !canSubmit && styles.disabled]}
                >
                  <Text style={[styles.buttonText, styles.primaryText]}>
                    {mode.kind === 'send' ? (saving ? 'Sending…' : 'Send back') : (saving ? 'Saving…' : 'Save')}
                  </Text>
                </Pressable>
              )}
            </View>
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
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.xl,
    maxHeight: '85%',
    gap: space.sm,
  },
  title: { color: colors.text, ...type.heading },
  note: { color: colors.textDim, ...type.bodySm },
  body: { color: colors.text, ...type.bodySm },
  error: { color: colors.red, ...type.bodySm },
  input: {
    minHeight: 160,
    maxHeight: 320,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceRaised,
    color: colors.text,
    padding: space.sm,
    textAlignVertical: 'top',
    ...type.monoSm,
  },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm, marginTop: space.xs },
  button: {
    minHeight: HIT,
    paddingHorizontal: space.lg,
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
