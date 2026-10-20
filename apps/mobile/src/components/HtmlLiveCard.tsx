/**
 * A ```html-live block in a chat message. The phone never runs the page: it
 * shows the still image the desktop captured and stored on the backend
 * (`HtmlLiveChannels.LOAD`, keyed by `htmlLiveImageKey`), the source, and
 * "Open on desktop", which asks a desktop window to open it in its pane.
 */
import React, { useEffect, useState } from 'react'
import { Image, Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { HTML_LIVE_CAPABILITY, HTML_LIVE_MAX_HEIGHT, type HtmlLiveState } from '@shared/html-live'
import { createLogger } from '@shared/logger'
import { htmlLiveImageKey } from '../lib/html-live-key'
import { getClient } from '../stores/connections'
import { colors, radius, space, type } from '../theme'

const log = createLogger('html-live')

/** The chat a message belongs to; absent where Markdown renders outside one. */
export interface MarkdownThread {
  connectionId: string
  threadId: string
}

const CACHE_LIMIT = 50
/** LOAD answers with an image, by connection and key, so scrolling back does not refetch. */
const loaded = new Map<string, HtmlLiveState>()

function remember(cacheKey: string, state: HtmlLiveState): void {
  loaded.delete(cacheKey)
  loaded.set(cacheKey, state)
  if (loaded.size > CACHE_LIMIT) loaded.delete(loaded.keys().next().value as string)
}

/** Test seam: the cache outlives a component, so tests start from empty. */
export function clearHtmlLiveCache(): void {
  loaded.clear()
}

type ImageState = { status: 'loading' } | { status: 'none' } | { status: 'image'; url: string }

const NO_IMAGE = 'No image yet. Your Mac makes one the next time it is online.'

export function HtmlLiveCard({
  source,
  title,
  closed,
  thread,
}: {
  source: string
  title: string | null
  closed: boolean
  thread?: MarkdownThread
}): React.ReactElement {
  const client = thread ? getClient(thread.connectionId) : undefined
  const capable = client?.supportsCapability(HTML_LIVE_CAPABILITY) === true
  const [image, setImage] = useState<ImageState>({ status: closed && capable ? 'loading' : 'none' })
  const [showSource, setShowSource] = useState(false)
  const [copied, setCopied] = useState(false)
  const [opened, setOpened] = useState<string | null>(null)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [cardWidth, setCardWidth] = useState(0)
  const [zoomed, setZoomed] = useState(false)
  const label = title ?? 'Live page'

  useEffect(() => {
    if (!closed || !client || !capable || !thread) {
      setImage({ status: 'none' })
      return
    }
    let current = true
    void (async () => {
      try {
        const key = await htmlLiveImageKey(source)
        const cacheKey = `${thread.connectionId}\n${key}`
        let state = loaded.get(cacheKey)
        if (!state) {
          state = await client.htmlLiveLoad(key)
          // A missing image is not cached: the desktop may store one later.
          if (state.image) remember(cacheKey, state)
        }
        if (current) setImage(state.image ? { status: 'image', url: state.image } : { status: 'none' })
      } catch (error) {
        log.warn('still image did not load', error)
        if (current) setImage({ status: 'none' })
      }
    })()
    return () => {
      current = false
    }
  }, [closed, client, capable, thread?.connectionId, source])

  useEffect(() => {
    if (image.status !== 'image') return
    let current = true
    Image.getSize(
      image.url,
      (width, height) => {
        if (current && width > 0 && height > 0) setSize({ width, height })
      },
      (error: unknown) => log.warn('still image size unreadable', error),
    )
    return () => {
      current = false
    }
  }, [image])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  const copy = (): void => {
    Clipboard.setStringAsync(source).then(
      () => setCopied(true),
      (error: unknown) => log.warn('source copy failed', error),
    )
  }

  const openOnDesktop = (): void => {
    if (!client || !thread) return
    client.htmlLiveOpenOnDesktop({ conversationId: thread.threadId, source, title }).then(
      (answer) => setOpened(answer?.ok ? 'Opened on your Mac' : 'Could not reach your Mac'),
      (error: unknown) => {
        log.warn('open on desktop failed', error)
        setOpened('Could not reach your Mac')
      },
    )
  }

  if (!closed) {
    return (
      <View style={styles.card}>
        <View style={styles.header}>
          <Text style={styles.title} numberOfLines={1}>
            {label}
          </Text>
        </View>
        <Text style={styles.muted}>Writing</Text>
      </View>
    )
  }

  const fullHeight = size && cardWidth > 0 ? (cardWidth * size.height) / size.width : null
  const cropped = fullHeight !== null && fullHeight > HTML_LIVE_MAX_HEIGHT

  return (
    <View style={styles.card} onLayout={(e) => setCardWidth(e.nativeEvent.layout.width)}>
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>
          {label}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={showSource ? 'Show image' : 'Show source'}
          onPress={() => setShowSource((s) => !s)}
          style={styles.button}
        >
          <Text style={styles.buttonText}>Source</Text>
        </Pressable>
      </View>
      {showSource ? (
        <View>
          <ScrollView style={styles.sourceScroll} nestedScrollEnabled>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <Text style={styles.source}>{source}</Text>
            </ScrollView>
          </ScrollView>
          <View style={styles.actions}>
            <Pressable accessibilityRole="button" accessibilityLabel="Copy source" onPress={copy} style={styles.button}>
              <Text style={styles.buttonText}>{copied ? 'Copied' : 'Copy source'}</Text>
            </Pressable>
            {capable && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Open on desktop"
                onPress={openOnDesktop}
                style={styles.button}
              >
                <Text style={styles.buttonText}>Open on desktop</Text>
              </Pressable>
            )}
            {opened !== null && <Text style={styles.result}>{opened}</Text>}
          </View>
        </View>
      ) : image.status === 'image' ? (
        <View>
          <Pressable
            accessibilityRole="imagebutton"
            accessibilityLabel={`View the whole image of ${label}`}
            onPress={() => setZoomed(true)}
            disabled={!cropped}
            style={{
              height: fullHeight === null ? 160 : Math.min(fullHeight, HTML_LIVE_MAX_HEIGHT),
              overflow: 'hidden',
            }}
          >
            <Image
              testID="html-live-image"
              source={{ uri: image.url }}
              style={{ width: '100%', height: fullHeight ?? 160 }}
              resizeMode={fullHeight === null ? 'contain' : 'stretch'}
            />
          </Pressable>
          {cropped && <Text style={styles.muted}>First 480 px. Tap to view the whole image.</Text>}
          <Text style={styles.muted}>Still image. Interactive on your Mac.</Text>
          <ZoomModal url={image.url} size={size} visible={zoomed} onClose={() => setZoomed(false)} />
        </View>
      ) : image.status === 'loading' ? (
        <Text style={styles.muted}>Loading image...</Text>
      ) : (
        <Text style={styles.muted}>{NO_IMAGE}</Text>
      )}
    </View>
  )
}

function ZoomModal({
  url,
  size,
  visible,
  onClose,
}: {
  url: string
  size: { width: number; height: number } | null
  visible: boolean
  onClose: () => void
}): React.ReactElement {
  const { width } = useWindowDimensions()
  const height = size ? (width * size.height) / size.width : width
  return (
    <Modal visible={visible} animationType="fade" onRequestClose={onClose}>
      <View style={styles.zoomRoot}>
        <Pressable accessibilityRole="button" accessibilityLabel="Close image" onPress={onClose} style={styles.close}>
          <Text style={styles.buttonText}>Close</Text>
        </Pressable>
        <ScrollView maximumZoomScale={4} minimumZoomScale={1} contentContainerStyle={styles.zoomContent}>
          <Image source={{ uri: url }} style={{ width, height }} resizeMode="stretch" />
        </ScrollView>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.sm,
    marginVertical: space.xs,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { ...type.bodySm, color: colors.textDim, flex: 1 },
  button: {
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderRadius: radius.sm,
    backgroundColor: colors.wash,
  },
  buttonText: { ...type.bodySm, color: colors.textDim },
  muted: { ...type.bodySm, color: colors.textDim, paddingHorizontal: space.md, paddingVertical: space.sm },
  sourceScroll: { maxHeight: HTML_LIVE_MAX_HEIGHT },
  source: { ...type.mono, color: colors.text, padding: space.md },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingBottom: space.sm,
  },
  result: { ...type.bodySm, color: colors.textDim },
  zoomRoot: { flex: 1, backgroundColor: colors.bg, paddingTop: space.xxl },
  close: { alignSelf: 'flex-end', margin: space.md, paddingHorizontal: space.md, paddingVertical: space.sm },
  zoomContent: { alignItems: 'center' },
})
