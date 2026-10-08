/**
 * A ```mermaid or ```chart block in a chat message, drawn by the bundled
 * visual host page (scripts/build-visual-host.mjs) in a locked-down WebView:
 * only that local HTML loads, nothing navigates, the page's CSP blocks the
 * network, and the source goes in as a message, never as markup. An invalid
 * chart or a diagram that does not draw shows its error and the source.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Asset } from 'expo-asset'
import * as Clipboard from 'expo-clipboard'
import * as FileSystem from 'expo-file-system/legacy'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import { chartDataText, parseChartSpec, type VisualKind } from '@shared/chat-visuals'
import { createLogger } from '@shared/logger'
import { colors, radius, space, type } from '../theme'

const log = createLogger('visual')

const THEME = {
  dark: true,
  background: colors.surfaceRaised,
  surface: colors.surface,
  text: colors.text,
  muted: colors.textDim,
  line: colors.textDim,
  border: colors.borderStrong,
  font: 'sans-serif',
  series: [colors.accent, colors.green, colors.amber, colors.purple, '#39c5cf', '#db61a2', colors.red, colors.textDim],
}

let hostHtml: Promise<string> | null = null

function loadHostHtml(): Promise<string> {
  if (!hostHtml) {
    hostHtml = (async () => {
      const asset = Asset.fromModule(require('../../assets/visual-host/visual-host.html'))
      await asset.downloadAsync()
      if (!asset.localUri) throw new Error('visual host asset has no local file')
      return FileSystem.readAsStringAsync(asset.localUri)
    })()
    hostHtml.catch(() => { hostHtml = null })
  }
  return hostHtml
}

interface Drawn { height: number; svg: string }
type State = { status: 'drawing' } | ({ status: 'drawn' } & Drawn) | { status: 'error'; error: string }

/** Drawn heights by source, so a recycled row does not jump while it redraws. */
const drawnCache = new Map<string, Drawn>()

/** Only the bundled page itself loads; every other URL is refused, never opened elsewhere. */
function onlyTheHostPage(request: { url: string }): boolean {
  return request.url === 'about:blank'
}

export function ChatVisual({ kind, source }: { kind: VisualKind; source: string }): React.ReactElement {
  const chart = useMemo(() => (kind === 'chart' ? parseChartSpec(source) : null), [kind, source])
  const cacheKey = `${kind}\n${source}`
  const [state, setState] = useState<State>(() => {
    const hit = drawnCache.get(cacheKey)
    return hit ? { status: 'drawn', ...hit } : { status: 'drawing' }
  })
  const [html, setHtml] = useState<string | null>(null)
  const [showSource, setShowSource] = useState(false)
  const [copied, setCopied] = useState(false)
  const webRef = useRef<WebView>(null)
  const invalid = chart && !chart.ok ? chart.error : state.status === 'error' ? state.error : null
  const noun = kind === 'mermaid' ? 'Diagram' : 'Chart'

  useEffect(() => {
    if (invalid !== null || html !== null) return
    let current = true
    loadHostHtml().then((page) => { if (current) setHtml(page) }, (error: unknown) => {
      log.warn('visual host did not load', error)
      if (current) setState({ status: 'error', error: 'This app version cannot draw it.' })
    })
    return () => { current = false }
  }, [invalid, html])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  const onMessage = (event: WebViewMessageEvent): void => {
    let answer: { type?: unknown; height?: unknown; svg?: unknown; error?: unknown }
    try {
      answer = JSON.parse(event.nativeEvent.data)
    } catch (error) {
      log.warn('visual host sent an unreadable answer', error)
      return
    }
    if (answer.type === 'drawn' && typeof answer.height === 'number' && typeof answer.svg === 'string') {
      const drawn = { height: Math.min(1200, Math.max(24, Math.ceil(answer.height))), svg: answer.svg }
      drawnCache.set(cacheKey, drawn)
      if (drawnCache.size > 50) drawnCache.delete(drawnCache.keys().next().value as string)
      setState({ status: 'drawn', ...drawn })
    } else if (answer.type === 'error') {
      setState({ status: 'error', error: typeof answer.error === 'string' ? answer.error : 'It could not be drawn.' })
    }
  }

  const copy = (): void => {
    const text = chart?.ok ? chartDataText(chart.spec) : state.status === 'drawn' ? state.svg : null
    if (text === null) return
    Clipboard.setStringAsync(text).then(() => setCopied(true), (error: unknown) => log.warn('visual copy failed', error))
  }

  const canCopy = invalid === null && (chart?.ok === true || state.status === 'drawn')
  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.title}>{noun}</Text>
        {invalid === null && (
          <Pressable accessibilityRole="button" accessibilityLabel={showSource ? `Show ${noun.toLowerCase()}` : 'Show source'} onPress={() => setShowSource((s) => !s)} style={styles.button}>
            <Text style={styles.buttonText}>Source</Text>
          </Pressable>
        )}
        {canCopy && (
          <Pressable accessibilityRole="button" accessibilityLabel={kind === 'mermaid' ? 'Copy SVG' : 'Copy data'} onPress={copy} style={styles.button}>
            <Text style={styles.buttonText}>{copied ? 'Copied' : kind === 'mermaid' ? 'Copy SVG' : 'Copy data'}</Text>
          </Pressable>
        )}
      </View>
      {invalid !== null && <Text style={styles.error}>{`This ${noun.toLowerCase()} could not be drawn: ${invalid}`}</Text>}
      {invalid !== null || showSource ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <Text style={styles.source}>{source}</Text>
        </ScrollView>
      ) : html === null ? (
        <Text style={styles.pending}>{`Drawing ${noun.toLowerCase()}...`}</Text>
      ) : (
        <WebView
          ref={webRef}
          source={{ html }}
          style={{ height: state.status === 'drawn' ? state.height : 160, backgroundColor: THEME.background }}
          originWhitelist={['*']}
          onShouldStartLoadWithRequest={onlyTheHostPage}
          onLoadEnd={() => webRef.current?.postMessage(JSON.stringify({ kind, source, theme: THEME }))}
          onMessage={onMessage}
          javaScriptEnabled
          domStorageEnabled={false}
          allowFileAccess={false}
          allowFileAccessFromFileURLs={false}
          allowUniversalAccessFromFileURLs={false}
          setSupportMultipleWindows={false}
          javaScriptCanOpenWindowsAutomatically={false}
          mixedContentMode="never"
          cacheEnabled={false}
          incognito
          scrollEnabled={false}
        />
      )}
    </View>
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
  button: { paddingHorizontal: space.sm, paddingVertical: space.xs, borderRadius: radius.sm, backgroundColor: colors.wash },
  buttonText: { ...type.bodySm, color: colors.textDim },
  error: { ...type.bodySm, color: colors.red, paddingHorizontal: space.md, paddingTop: space.sm },
  source: { ...type.mono, color: colors.text, padding: space.md },
  pending: { ...type.bodySm, color: colors.textDim, padding: space.md },
})
