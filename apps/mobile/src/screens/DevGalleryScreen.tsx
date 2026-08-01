/**
 * Every feed row and composer state on one screen, for looking at.
 *
 * Component tests assert what someone thought to assert. This covers the other
 * half: states that are awkward to reach on purpose - an empty thread that is
 * still loading, an image with no caption, a tool that never completed - and
 * where the bug is "it looks wrong" rather than a wrong value. Both of those
 * shipped to a device before this existed.
 *
 * Dev only; the entry point is hidden unless __DEV__.
 */
import React, { useState } from 'react'
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native'
import { ToolItem, TextItem } from './ThreadScreen'
import { SendMicButton } from '../components/SendMicButton'
import { SlashMenu } from '../components/SlashMenu'
import { BuildStamp } from '../components/BuildStamp'
import { allCommands } from '../lib/slash'
import type { Dictation } from '../hooks/useDictation'
import type { FeedItem } from '../stores/chat'
import { colors, radius, space, type } from '../theme'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title.toUpperCase()}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  )
}

const dictation = (over: Partial<Dictation> = {}): Dictation => ({
  available: true,
  listening: false,
  start: async () => true,
  stop: () => {},
  ...over,
})

const tool = (over: Partial<Extract<FeedItem, { kind: 'tool' }>> = {}) =>
  ({
    kind: 'tool' as const,
    id: `t-${Math.random()}`,
    toolName: 'Bash',
    input: { command: 'npm run typecheck' },
    state: 'done' as const,
    output: 'ok',
    ...over,
  })

const text = (over: Partial<Extract<FeedItem, { kind: 'text' }>> = {}) =>
  ({
    kind: 'text' as const,
    id: `m-${Math.random()}`,
    text: 'Plain reply.',
    stream: 'assistant' as const,
    done: true,
    ...over,
  })

export default function DevGalleryScreen() {
  const [listening, setListening] = useState(false)

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <BuildStamp />

      <Section title="Loading and empty states">
        {/* The upside-down loader lived exactly here, in a state that needs an
            empty thread mid-load to reproduce. */}
        <View style={styles.emptyWrap}>
          <ActivityIndicator size="small" color={colors.textDim} />
          <Text style={styles.emptyText}>Loading conversation</Text>
        </View>
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyText}>Session started. Say something below.</Text>
        </View>
      </Section>

      <Section title="Assistant text">
        <TextItem item={text({ text: '## Heading\n\nSome **bold** and `inline code`.' })} />
        <TextItem item={text({ text: '```ts\nconst a: number = 1\n```' })} />
        <TextItem item={text({ text: '- one\n- two\n  - nested' })} />
        <TextItem item={text({ text: 'Timed reply.', durationMs: 2400 })} />
        <TextItem item={text({ text: 'Still streaming', done: false })} />
      </Section>

      <Section title="Tool calls">
        <ToolItem item={tool({ state: 'running', output: undefined })} />
        <ToolItem item={tool()} />
        <ToolItem item={tool({ output: 'many\nlines\nof\noutput\nhere\nand\nmore' })} />
        <ToolItem item={tool({ toolName: 'Read', input: { file_path: '/a/b/c/deep/file.ts' } })} />
        <ToolItem item={tool({ toolName: 'Grep', input: { pattern: 'TODO', path: '/repo/src' } })} />
        <ToolItem item={tool({ toolName: 'mcp__unknown__thing', input: { alpha: 1 } })} />
      </Section>

      <Section title="Slash menu">
        <SlashMenu commands={allCommands([]).slice(0, 4)} onPick={() => {}} />
      </Section>

      <Section title="Primary button">
        <View style={styles.row}>
          <Labelled label="empty">
            <SendMicButton canSend={false} isRunning={false} dictation={dictation()} onSend={() => {}} onStopTurn={() => {}} />
          </Labelled>
          <Labelled label="can send">
            <SendMicButton canSend isRunning={false} dictation={dictation()} onSend={() => {}} onStopTurn={() => {}} />
          </Labelled>
          <Labelled label="running">
            <SendMicButton canSend={false} isRunning dictation={dictation()} onSend={() => {}} onStopTurn={() => {}} />
          </Labelled>
          <Labelled label="dictating">
            <SendMicButton
              canSend={false}
              isRunning={false}
              dictation={dictation({ listening })}
              onSend={() => setListening((v) => !v)}
              onStopTurn={() => {}}
            />
          </Labelled>
        </View>
        <Text style={styles.note}>Tap "dictating" to toggle the recording ring.</Text>
      </Section>
    </ScrollView>
  )
}

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.labelled}>
      {children}
      <Text style={styles.labelledText}>{label}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.lg, paddingBottom: space.xl * 2 },
  section: { marginBottom: space.xl },
  sectionTitle: { color: colors.textFaint, ...type.label, marginBottom: space.sm },
  sectionBody: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: space.md,
    gap: space.sm,
  },
  row: { flexDirection: 'row', gap: space.lg, flexWrap: 'wrap' },
  labelled: { alignItems: 'center', gap: space.xs },
  labelledText: { color: colors.textFaint, ...type.monoSm },
  emptyWrap: { alignItems: 'center', justifyContent: 'center', paddingVertical: space.lg },
  emptyText: { color: colors.textFaint, fontSize: 13, marginTop: space.sm },
  note: { color: colors.textFaint, ...type.bodySm, marginTop: space.sm },
})
