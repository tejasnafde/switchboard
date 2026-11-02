/**
 * The Hub row of a parent chat (flag `hub_children`): "Hub · 3 children" and
 * the parent state, which opens the list of its children with their state
 * text, a machine badge for a child on another machine, Open and Stop, and
 * Stop all. Read from the backend's hub view on open and on every
 * `hub.children-changed` for this chat, like the desktop strip, so both show
 * the same states.
 */
import React, { useEffect, useState } from 'react'
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native'
import {
  canStopHubChild,
  childStateLabel,
  hubChildStopTarget,
  hubChipText,
  HUB_REMOTE_CHILD_NO_REPORT,
  HUB_REMOTE_CHILD_READ_NOTE,
  type HubChatRef,
  type HubChatView,
  type HubChildView,
} from '@shared/hub'
import { createLogger } from '@shared/logger'
import type { SwitchboardClient } from '../lib/api'
import { hubChangeConcerns, phoneHubView } from '../lib/hub-children'
import { colors, fonts } from '../theme'
import { styles as threadStyles } from '../screens/thread-screen.styles'

const log = createLogger('thread:hub')

/** A child on another machine has no transcript here yet: its newest report and where to read the rest. */
function showRemoteChild(child: HubChildView): void {
  const machine = child.remote?.machine ?? ''
  Alert.alert(
    child.chat.title,
    [
      `${machine} · ${childStateLabel(child)}`,
      child.lastWake?.summary ?? HUB_REMOTE_CHILD_NO_REPORT,
      HUB_REMOTE_CHILD_READ_NOTE,
    ].join('\n\n'),
  )
}

function ChildRow({ child, onOpen, onStop }: { child: HubChildView; onOpen: () => void; onStop: () => void }) {
  const state = `${childStateLabel(child)}${child.lastWake ? `: ${child.lastWake.summary}` : ''}`
  return (
    <View style={hubStyles.child} testID="hub-child-row">
      <View style={hubStyles.childTitleLine}>
        <Text style={hubStyles.childTitle} numberOfLines={1}>
          {child.chat.title}
        </Text>
        {child.remote && (
          <Text style={hubStyles.machine} numberOfLines={1} testID="hub-machine-badge">
            {child.remote.machine}
          </Text>
        )}
      </View>
      <Text style={threadStyles.forkBannerText} numberOfLines={2}>
        {state}
      </Text>
      <View style={hubStyles.actions}>
        <Pressable
          onPress={onOpen}
          accessibilityRole="button"
          accessibilityLabel={`Open ${child.chat.title}`}
          hitSlop={8}
        >
          <Text style={threadStyles.compactAction}>Open</Text>
        </Pressable>
        {canStopHubChild(child) && (
          <Pressable
            onPress={onStop}
            accessibilityRole="button"
            accessibilityLabel={`Stop ${child.chat.title}`}
            hitSlop={8}
          >
            <Text style={hubStyles.stop}>Stop</Text>
          </Pressable>
        )}
      </View>
    </View>
  )
}

export function HubChildrenRow({
  client,
  threadId,
  remoteOn,
  onOpenChat,
}: {
  client: SwitchboardClient
  threadId: string
  /** The backend advertises `hub_remote_children_v1`: machine badges and the remote Open. */
  remoteOn: boolean
  onOpenChat: (chat: HubChatRef) => void
}) {
  const [view, setView] = useState<HubChatView | null>(null)
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    let current: HubChatView | null = null
    const read = () =>
      client
        .hubListChildren(threadId)
        .then((next) => {
          if (!live) return
          current = phoneHubView(next, remoteOn)
          setView(current)
        })
        .catch((err: unknown) => log.warn('reading the hub view failed', err))
    void read()
    const off = client.onEvent((event) => {
      if (event.type !== 'hub.children-changed' || !hubChangeConcerns(current, threadId, event.threadId)) return
      void read()
    })
    return () => {
      live = false
      off()
    }
  }, [client, threadId, remoteOn])

  if (!view?.self || view.children.length === 0) return null
  const parent = view.self
  const stoppable = view.children.filter(canStopHubChild)

  const act = (what: string, run: () => Promise<unknown>) => {
    setNote(null)
    run().catch((err: unknown) => {
      log.warn(`${what} failed`, err)
      setNote(err instanceof Error ? err.message : String(err))
    })
  }
  const stopChild = (child: HubChildView) => {
    const target = hubChildStopTarget(child)
    if (target) act('stopping a child', () => client.interrupt(target))
  }
  const openChild = (child: HubChildView) => (child.remote ? showRemoteChild(child) : onOpenChat(child.chat))

  return (
    <View style={threadStyles.forkBanner} testID="hub-children-row">
      <View style={threadStyles.compactBanner}>
        <Pressable
          onPress={() => setOpen((v) => !v)}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={hubChipText(view)}
          style={threadStyles.compactBannerText}
        >
          <Text style={threadStyles.limitResumeTitle} numberOfLines={1}>
            {hubChipText(view)}
          </Text>
        </Pressable>
        {open && stoppable.length > 0 && (
          <Pressable
            onPress={() => act('stopping the children', () => client.hubStopChildren(parent.id))}
            accessibilityRole="button"
            accessibilityLabel="Stop all"
            hitSlop={8}
          >
            <Text style={hubStyles.stop}>Stop all</Text>
          </Pressable>
        )}
      </View>
      {note && (
        <Text style={threadStyles.limitResumeNote} accessibilityRole="alert">
          {note}
        </Text>
      )}
      {open &&
        view.children.map((child) => (
          <ChildRow key={child.chat.id} child={child} onOpen={() => openChild(child)} onStop={() => stopChild(child)} />
        ))}
    </View>
  )
}

const hubStyles = StyleSheet.create({
  child: {
    paddingTop: 6,
    marginTop: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  childTitleLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  childTitle: { flexShrink: 1, color: colors.text, fontSize: 13, lineHeight: 18 },
  machine: {
    maxWidth: '50%',
    color: colors.textDim,
    fontFamily: fonts.mono,
    fontSize: 10.5,
    lineHeight: 15,
    paddingHorizontal: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 4,
  },
  actions: { flexDirection: 'row', gap: 16, marginTop: 2 },
  stop: { color: colors.red, fontSize: 11, lineHeight: 15 },
})
