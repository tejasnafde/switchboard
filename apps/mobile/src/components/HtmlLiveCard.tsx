/**
 * A ```html-live block in a chat message. It shows the still image the desktop
 * captured and stored on the backend (`HtmlLiveChannels.LOAD`, keyed by
 * `htmlLiveImageKey`), the source, and "Open on desktop", which asks a desktop
 * window to open it in its pane. With `phone_html_live_run` on, Run starts the
 * page in `HtmlLiveFrame` in the same box (no touches inline; a tap opens the
 * full-screen view), and `lib/live-pages` picks the one page that runs.
 */
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  Dimensions,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native'
import * as Clipboard from 'expo-clipboard'
import * as FileSystem from 'expo-file-system/legacy'
import * as Sharing from 'expo-sharing'
import { HTML_LIVE_CAPABILITY, HTML_LIVE_MAX_HEIGHT, htmlLiveFrameHeight, type HtmlLiveState } from '@shared/html-live'
import { PHONE_LIVE_DESKTOP_ONLY_NOTE, htmlLivePhoneVerdict } from '@shared/html-live-phone'
import { createLogger } from '@shared/logger'
import { htmlLiveImageKey } from '../lib/html-live-key'
import {
  livePageBlocked,
  livePageCrashes,
  noteLivePageCrash,
  registerLivePage,
  runningLivePage,
  setLivePageFullScreen,
  setLivePageRun,
  stopLivePage,
  subscribeLivePages,
} from '../lib/live-pages'
import { getClient } from '../stores/connections'
import { usePrefsStore } from '../stores/prefs'
import { HtmlLiveFrame, liveLibrariesSupported } from './HtmlLiveFrame'
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

type ImageState =
  | { status: 'loading' }
  | { status: 'none' }
  | { status: 'image'; url: string; savedPath: string | null }

/** The shared file's name: the saved page's name when there is one, else the title. */
function imageStem(savedPath: string | null, label: string): string {
  const base = savedPath ? (savedPath.split('/').pop() ?? '').replace(/\.[^.]*$/, '') : label
  return base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '') || 'live-page'
}

const NO_IMAGE = 'No image yet. Your Mac makes one the next time it is online.'
const STOPPED = 'This page stopped.'

let nextLiveId = 0

/** Part of a box of this top and height inside a window of this height, 0 to 1. */
function visibleFraction(top: number, height: number, windowHeight: number): number {
  if (height <= 0) return 0
  return Math.max(0, Math.min(top + height, windowHeight) - Math.max(top, 0)) / height
}

export function HtmlLiveCard({
  source,
  title,
  thread,
}: {
  source: string
  title: string | null
  thread?: MarkdownThread
}): React.ReactElement {
  const client = thread ? getClient(thread.connectionId) : undefined
  const capable = client?.supportsCapability(HTML_LIVE_CAPABILITY) === true
  const [image, setImage] = useState<ImageState>({ status: capable ? 'loading' : 'none' })
  const [showSource, setShowSource] = useState(false)
  const [copied, setCopied] = useState(false)
  const [opened, setOpened] = useState<string | null>(null)
  const [shareError, setShareError] = useState<string | null>(null)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [cardWidth, setCardWidth] = useState(0)
  const [zoomed, setZoomed] = useState(false)
  const label = title ?? 'Live page'

  const liveOn = usePrefsStore((s) => s.liveHtmlPages)
  const verdict = htmlLivePhoneVerdict(source, true)
  const desktopOnly = liveOn && !verdict.ok && verdict.reason === 'desktop-only'
  const runnable = liveOn && verdict.ok && liveLibrariesSupported(source)
  const [pageKey, setPageKey] = useState<string | null>(null)
  const [liveId] = useState(() => `live-${++nextLiveId}`)
  const [fullScreen, setFullScreen] = useState(false)
  const [stopped, setStopped] = useState(false)
  const [runHeight, setRunHeight] = useState<number | null>(null)
  const boxRef = useRef<View>(null)
  const running = useSyncExternalStore(subscribeLivePages, runningLivePage) === liveId && runnable
  const blocked = pageKey !== null && livePageBlocked(pageKey)

  useEffect(() => {
    setPageKey(null)
    if (!runnable) return
    let current = true
    htmlLiveImageKey(source).then(
      (key) => {
        if (current) setPageKey(key)
      },
      (error: unknown) => log.warn('live page key failed', error),
    )
    return () => {
      current = false
    }
  }, [runnable, source])

  useEffect(() => {
    if (!runnable || pageKey === null) return
    const measure = (): Promise<number> =>
      new Promise((resolve) => {
        const node = boxRef.current
        if (!node) return resolve(0)
        node.measureInWindow((_x, top, _width, height) =>
          resolve(visibleFraction(top, height, Dimensions.get('window').height)),
        )
      })
    return registerLivePage(liveId, pageKey, measure)
  }, [runnable, pageKey, liveId])

  const run = (): void => {
    setStopped(false)
    setLivePageRun(liveId, true)
  }
  const openFullScreen = (): void => {
    setFullScreen(true)
    setLivePageFullScreen(liveId, true)
  }
  const closeFullScreen = (): void => {
    setFullScreen(false)
    setLivePageFullScreen(liveId, false)
  }
  const stop = (why: string): void => {
    log.info('live page stopped', { why })
    setStopped(true)
    setFullScreen(false)
    stopLivePage(liveId)
  }
  const crash = (): void => {
    log.warn('live page process ended')
    setStopped(true)
    setFullScreen(false)
    noteLivePageCrash(liveId)
  }

  useEffect(() => {
    if (!client || !capable || !thread) {
      setImage({ status: 'none' })
      return
    }
    setImage({ status: 'loading' })
    setSize(null)
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
        if (current) {
          setImage(state.image ? { status: 'image', url: state.image, savedPath: state.savedPath } : { status: 'none' })
        }
      } catch (error) {
        log.warn('still image did not load', error)
        if (current) setImage({ status: 'none' })
      }
    })()
    return () => {
      current = false
    }
  }, [client, capable, thread?.connectionId, source])

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
      (answer) => setOpened(answer?.ok ? 'Opened on your Mac' : (answer?.error ?? 'Could not reach your Mac')),
      (error: unknown) => {
        log.warn('open on desktop failed', error)
        setOpened('Could not reach your Mac')
      },
    )
  }

  const shareImage = (): void => {
    if (image.status !== 'image') return
    const { url, savedPath } = image
    setShareError(null)
    void (async () => {
      try {
        // A tall page's still is a JPEG: share it as one.
        const jpeg = url.startsWith('data:image/jpeg')
        const uri = `${FileSystem.cacheDirectory}${imageStem(savedPath, label)}.${jpeg ? 'jpg' : 'png'}`
        await FileSystem.writeAsStringAsync(uri, url.slice(url.indexOf(',') + 1), {
          encoding: FileSystem.EncodingType.Base64,
        })
        await Sharing.shareAsync(uri, {
          mimeType: jpeg ? 'image/jpeg' : 'image/png',
          UTI: jpeg ? 'public.jpeg' : 'public.png',
          dialogTitle: 'Share image',
        })
      } catch (error) {
        log.warn('still image share failed', error)
        setShareError('Could not share the image.')
      }
    })()
  }

  const fullHeight = size && cardWidth > 0 ? (cardWidth * size.height) / size.width : null
  const cropped = runHeight === null && fullHeight !== null && fullHeight > HTML_LIVE_MAX_HEIGHT
  // One height for the still image and the running page, so a swap never moves the list.
  const boxHeight =
    runHeight ?? (image.status === 'image' && fullHeight !== null ? Math.min(fullHeight, HTML_LIVE_MAX_HEIGHT) : 160)
  const frame = (inFullScreen: boolean): React.ReactElement => (
    <HtmlLiveFrame
      source={source}
      fullScreen={inFullScreen}
      onHeight={(height) => setRunHeight(htmlLiveFrameHeight(height, false))}
      onStop={stop}
      onCrash={crash}
    />
  )
  const runLabel = stopped || (pageKey !== null && livePageCrashes(pageKey) > 0) ? 'Run again' : 'Run'
  const liveControls = runnable && !running && (
    <View style={styles.actions}>
      {(stopped || blocked) && <Text style={styles.result}>{STOPPED}</Text>}
      {!blocked && (
        <Pressable accessibilityRole="button" accessibilityLabel={runLabel} onPress={run} style={styles.button}>
          <Text style={styles.buttonText}>{runLabel}</Text>
        </Pressable>
      )}
    </View>
  )

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
            {image.status === 'image' && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Share image"
                onPress={shareImage}
                style={styles.button}
              >
                <Text style={styles.buttonText}>Share image</Text>
              </Pressable>
            )}
            {opened !== null && <Text style={styles.result}>{opened}</Text>}
            {shareError !== null && <Text style={styles.result}>{shareError}</Text>}
          </View>
        </View>
      ) : running && !fullScreen ? (
        <View ref={boxRef}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open ${label} full screen`}
            onPress={openFullScreen}
            style={{ height: boxHeight }}
          >
            {/* No touches inline: the list keeps its gestures, a tap opens the full-screen view. */}
            <View pointerEvents="none" style={styles.fill}>
              {frame(false)}
            </View>
          </Pressable>
          <Text style={styles.muted}>Live. Tap to open full screen.</Text>
        </View>
      ) : image.status === 'image' ? (
        <View ref={boxRef}>
          <Pressable
            accessibilityRole="imagebutton"
            accessibilityLabel={`View the whole image of ${label}`}
            onPress={() => setZoomed(true)}
            disabled={!cropped}
            style={{ height: boxHeight, overflow: 'hidden' }}
          >
            <Image
              testID="html-live-image"
              source={{ uri: image.url }}
              style={{ width: '100%', height: fullHeight ?? 160 }}
              resizeMode={fullHeight === null ? 'contain' : 'stretch'}
            />
          </Pressable>
          {cropped && <Text style={styles.muted}>First 480 px. Tap to view the whole image.</Text>}
          <Text style={styles.muted}>{runnable ? 'Still image.' : 'Still image. Interactive on your Mac.'}</Text>
          {desktopOnly && <Text style={styles.muted}>{PHONE_LIVE_DESKTOP_ONLY_NOTE}</Text>}
          {liveControls}
          <ZoomModal url={image.url} size={size} visible={zoomed} onClose={() => setZoomed(false)} />
        </View>
      ) : (
        <View ref={boxRef} style={runnable ? { height: boxHeight } : undefined}>
          <Text style={styles.muted}>{image.status === 'loading' ? 'Loading image...' : NO_IMAGE}</Text>
          {desktopOnly && <Text style={styles.muted}>{PHONE_LIVE_DESKTOP_ONLY_NOTE}</Text>}
        </View>
      )}
      {image.status !== 'image' && !showSource && liveControls}
      {runnable && (
        <Modal visible={fullScreen} animationType="slide" onRequestClose={closeFullScreen}>
          <View style={styles.fullRoot}>
            <View style={styles.fullHeader}>
              <View style={styles.fill}>
                <Text style={styles.fullTitle} numberOfLines={1}>
                  {label}
                </Text>
                <Text style={styles.result}>Live page from the agent</Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close live page"
                onPress={closeFullScreen}
                style={styles.button}
              >
                <Text style={styles.buttonText}>Close</Text>
              </Pressable>
            </View>
            {running && fullScreen ? frame(true) : <Text style={styles.muted}>Starting...</Text>}
          </View>
        </Modal>
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
  fill: { flex: 1 },
  fullRoot: { flex: 1, backgroundColor: colors.bg, paddingTop: space.xxl },
  fullHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  fullTitle: { ...type.body, color: colors.text },
  zoomRoot: { flex: 1, backgroundColor: colors.bg, paddingTop: space.xxl },
  close: { alignSelf: 'flex-end', margin: space.md, paddingHorizontal: space.md, paddingVertical: space.sm },
  zoomContent: { alignItems: 'center' },
})
