/**
 * The Limited row of a chat (flag `limit_auto_resume`): "Usage limit.
 * Resumes 15:40." over what happens next, with Resume now and Cancel
 * auto-resume while a resume is armed, or why none is. Read from the
 * backend on open and on every `limit-resume.changed`, like the desktop row,
 * so both show the same thing.
 */
import React, { useEffect, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { limitStateDetail, limitStateText, type LimitState } from '@shared/limit-resume'
import type { SwitchboardClient } from '../lib/api'
import { createLogger } from '@shared/logger'
import { styles } from '../screens/thread-screen.styles'

const log = createLogger('thread:limit-resume')

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export function LimitResumeRow({ client, threadId }: { client: SwitchboardClient; threadId: string }) {
  const [state, setState] = useState<LimitState>({ kind: 'none' })
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    const read = () =>
      client
        .limitResumeGet(threadId)
        .then((next) => {
          if (live) setState(next)
        })
        .catch((err: unknown) => log.warn('reading the Limited row failed', err))
    void read()
    // The event names the live id, which can differ from this chat's: re-read on any.
    const off = client.onEvent((event) => {
      if (event.type !== 'limit-resume.changed') return
      setNote(null)
      void read()
    })
    return () => {
      live = false
      off()
    }
  }, [client, threadId])

  const text = limitStateText(state, clock)
  if (!text) return null

  const act = async (action: 'now' | 'cancel') => {
    setBusy(true)
    setNote(null)
    try {
      if (action === 'cancel') await client.limitResumeCancel(threadId)
      else {
        const result = await client.limitResumeNow(threadId)
        if (!result.ok) setNote(result.message)
      }
    } catch (err) {
      log.warn(`${action} of the auto-resume failed`, err)
      setNote(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const detail = limitStateDetail(state)
  return (
    <View style={styles.forkBanner} testID="limit-resume-row">
      <View accessibilityLiveRegion="polite">
        <Text style={styles.limitResumeTitle}>{text}</Text>
        {detail && <Text style={styles.forkBannerText}>{detail}</Text>}
      </View>
      {note && (
        <Text style={styles.limitResumeNote} accessibilityRole="alert">
          {note}
        </Text>
      )}
      {state.kind === 'armed' && (
        <View style={styles.buttonRow}>
          <Pressable
            onPress={() => void act('now')}
            disabled={busy}
            style={[styles.actionButton, styles.implementButton, busy && styles.buttonDisabled]}
            accessibilityRole="button"
            accessibilityLabel="Resume now"
          >
            <Text style={styles.actionLabel}>Resume now</Text>
          </Pressable>
          <Pressable
            onPress={() => void act('cancel')}
            disabled={busy}
            style={[styles.actionButton, styles.iterateButton, busy && styles.buttonDisabled]}
            accessibilityRole="button"
            accessibilityLabel="Cancel auto-resume"
          >
            <Text style={styles.iterateLabel}>Cancel auto-resume</Text>
          </Pressable>
        </View>
      )}
    </View>
  )
}
