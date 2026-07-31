/**
 * Renders the block list from lib/markdown with plain RN primitives.
 *
 * Parsing lives in lib/markdown.ts and is unit-tested; this file only maps
 * nodes to styles. Code blocks scroll horizontally rather than wrapping, since
 * wrapped code is unreadable and agent output is full of it.
 */
import React, { memo, useMemo } from 'react'
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native'
import { parseMarkdown, type Block, type Inline } from '../lib/markdown'
import { colors, radius, space, type } from '../theme'

function renderInlines(nodes: Inline[], keyPrefix = ''): React.ReactNode[] {
  return nodes.map((node, i) => {
    const key = `${keyPrefix}${i}`
    switch (node.kind) {
      case 'text':
        return <Text key={key}>{node.text}</Text>
      case 'code':
        return (
          <Text key={key} style={styles.codeSpan}>
            {node.text}
          </Text>
        )
      case 'strong':
        return (
          <Text key={key} style={styles.strong}>
            {renderInlines(node.children, `${key}.`)}
          </Text>
        )
      case 'em':
        return (
          <Text key={key} style={styles.em}>
            {renderInlines(node.children, `${key}.`)}
          </Text>
        )
      case 'strike':
        return (
          <Text key={key} style={styles.strike}>
            {renderInlines(node.children, `${key}.`)}
          </Text>
        )
      case 'link':
        return (
          <Text
            key={key}
            style={styles.link}
            onPress={() => {
              void Linking.openURL(node.href).catch(() => {
                // A malformed href from an agent is not worth an alert.
              })
            }}
          >
            {renderInlines(node.children, `${key}.`)}
          </Text>
        )
    }
  })
}

const HEADING_STYLE = [styles_h(1), styles_h(2), styles_h(3), styles_h(4), styles_h(5), styles_h(6)]

function styles_h(level: number): { fontSize: number; lineHeight: number; marginTop: number } {
  const size = level <= 1 ? 20 : level === 2 ? 17 : 15
  return { fontSize: size, lineHeight: Math.round(size * 1.35), marginTop: level <= 2 ? space.md : space.sm }
}

const BlockView = memo(function BlockView({ block }: { block: Block }): React.ReactElement | null {
  switch (block.kind) {
    case 'paragraph':
      return <Text style={styles.body}>{renderInlines(block.inlines)}</Text>

    case 'heading':
      return (
        <Text style={[styles.heading, HEADING_STYLE[Math.min(block.level, 6) - 1]]}>
          {renderInlines(block.inlines)}
        </Text>
      )

    case 'code':
      return (
        <View style={styles.codeBlock}>
          {block.lang !== null && <Text style={styles.codeLang}>{block.lang}</Text>}
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <Text style={styles.codeText}>{block.text}</Text>
          </ScrollView>
        </View>
      )

    case 'listItem':
      return (
        <View style={[styles.listRow, { paddingLeft: space.md + block.depth * space.lg }]}>
          <Text style={styles.listMarker}>{block.marker}</Text>
          <Text style={[styles.body, styles.listBody]}>{renderInlines(block.inlines)}</Text>
        </View>
      )

    case 'quote':
      return (
        <View style={styles.quote}>
          <Text style={[styles.body, styles.quoteText]}>{renderInlines(block.inlines)}</Text>
        </View>
      )

    case 'rule':
      return <View style={styles.rule} />
  }
})

/**
 * `text` is re-parsed whenever it changes, which during streaming is once per
 * coalesced flush rather than once per token - see the chat store's batching.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }): React.ReactElement {
  const blocks = useMemo(() => parseMarkdown(text), [text])
  return (
    <View style={styles.root}>
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} />
      ))}
    </View>
  )
})

const styles = StyleSheet.create({
  root: { gap: space.xs },
  body: { color: colors.text, ...type.body },
  heading: { color: colors.text, fontWeight: '600', marginBottom: 2 },
  strong: { fontWeight: '700', color: colors.text },
  em: { fontStyle: 'italic' },
  strike: { textDecorationLine: 'line-through', color: colors.textDim },
  link: { color: colors.accent, textDecorationLine: 'underline' },
  codeSpan: {
    ...type.mono,
    color: colors.accent,
    backgroundColor: colors.surfaceRaised,
  },
  codeBlock: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    marginVertical: space.xs,
  },
  codeLang: { ...type.monoSm, color: colors.textDim, marginBottom: space.xs },
  codeText: { ...type.mono, color: colors.text },
  listRow: { flexDirection: 'row', gap: space.sm },
  listMarker: { color: colors.textDim, ...type.body },
  listBody: { flex: 1 },
  quote: {
    borderLeftColor: colors.border,
    borderLeftWidth: 2,
    paddingLeft: space.md,
    marginVertical: space.xs,
  },
  quoteText: { color: colors.textDim },
  rule: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginVertical: space.md,
  },
})
