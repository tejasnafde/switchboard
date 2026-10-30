/**
 * A running ```html-live page (`phone_html_live_run`). The page is untrusted:
 * it loads as one HTML string with an opaque origin and the CSP meta as its
 * first bytes (`htmlLivePhoneDocument`), the libraries it names come in as
 * `data:` URLs, nothing navigates after the first load, and the only channel
 * back is a capped, schema-checked message that sets a height or appends to a
 * capped list. Unmounting drops the WebView and the library strings.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Platform, StyleSheet, Text } from 'react-native'
import { Asset } from 'expo-asset'
import * as FileSystem from 'expo-file-system/legacy'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import { htmlLiveLibraryRefs, type HtmlLiveTheme } from '@shared/html-live'
import {
  PHONE_LIVE_GUARD,
  PHONE_LIVE_MAX_REPORTS,
  PHONE_LIVE_WATCHDOG_MS,
  htmlLivePhoneDocument,
  parsePhoneLiveMessage,
  phoneLiveRateGate,
} from '@shared/html-live-phone'
import { createLogger } from '@shared/logger'
import { colors, space, type } from '../theme'

const log = createLogger('html-live')

const THEME: HtmlLiveTheme = {
  scheme: 'dark',
  bg: colors.surfaceRaised,
  surface: colors.surface,
  text: colors.text,
  muted: colors.textDim,
  border: colors.borderStrong,
  accent: colors.accent,
  success: colors.green,
  warning: colors.amber,
  error: colors.red,
  font: 'sans-serif',
  mono: 'monospace',
  radius: '6px',
  chart: [colors.accent, colors.green, colors.amber, colors.purple, '#39c5cf', '#db61a2'],
}

/** The libraries the app ships, by the path a page names under /_sb/. */
const LIBRARY_ASSETS: Record<string, number> = {
  'chart.js': require('../../assets/live-libs/chart.sblib'),
  'd3.js': require('../../assets/live-libs/d3.sblib'),
  'three.js': require('../../assets/live-libs/three.sblib'),
  'three/addons/controls/OrbitControls.js': require('../../assets/live-libs/OrbitControls.sblib'),
}

/** iOS before 16.4 has no import maps, so a page that imports three cannot run. */
export function liveLibrariesSupported(source: string, version: string | number = Platform.Version): boolean {
  const needsImportMap = htmlLiveLibraryRefs(source).some((path) => path.startsWith('three'))
  if (!needsImportMap || Platform.OS !== 'ios') return true
  const [major = 0, minor = 0] = String(version).split('.').map(Number)
  return major > 16 || (major === 16 && minor >= 4)
}

/** `data:` URLs for the shipped libraries the page names, read for this run only. */
async function readLibraries(source: string): Promise<Map<string, string>> {
  const urls = new Map<string, string>()
  for (const path of htmlLiveLibraryRefs(source)) {
    const module = LIBRARY_ASSETS[path]
    if (module === undefined) continue
    const asset = Asset.fromModule(module)
    await asset.downloadAsync()
    if (!asset.localUri) throw new Error(`live page library ${path} has no local file`)
    const base64 = await FileSystem.readAsStringAsync(asset.localUri, { encoding: FileSystem.EncodingType.Base64 })
    urls.set(path, `data:text/javascript;base64,${base64}`)
  }
  return urls
}

/**
 * Every URL reaches `onShouldStartLoadWithRequest`. react-native-webview hands
 * a URL outside `originWhitelist` to `Linking.openURL` before that callback
 * runs, so a narrower list would let the page open https:, tel: or mailto:
 * links in other apps. The navigation gate below is the control.
 */
export const LIVE_ORIGIN_WHITELIST = ['*']

/** Allows the first `about:blank` load (the document itself) and refuses everything after it. */
export function liveNavigationGate(): (request: { url: string }) => boolean {
  let loaded = false
  return ({ url }) => {
    if (loaded || url !== 'about:blank') return false
    loaded = true
    return true
  }
}

export type LiveStop = 'watchdog' | 'reload' | 'libraries'

export function HtmlLiveFrame({
  source,
  fullScreen,
  onHeight,
  onStop,
  onCrash,
}: {
  source: string
  fullScreen: boolean
  /** The page's content height, debounced to 100 ms. */
  onHeight: (height: number) => void
  onStop: (why: LiveStop) => void
  onCrash: () => void
}): React.ReactElement {
  const [html, setHtml] = useState<string | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const [blocked, setBlocked] = useState<string[]>([])
  const gate = useMemo(liveNavigationGate, [])
  const rate = useMemo(() => phoneLiveRateGate(), [])
  const loads = useRef(0)
  const reported = useRef(false)
  const pendingHeight = useRef<ReturnType<typeof setTimeout> | null>(null)
  const callbacks = useRef({ onHeight, onStop, onCrash })
  callbacks.current = { onHeight, onStop, onCrash }

  useEffect(() => {
    let current = true
    readLibraries(source).then(
      (urls) => {
        if (current) setHtml(htmlLivePhoneDocument(source, THEME, (path) => urls.get(path) ?? ''))
      },
      (error: unknown) => {
        log.warn('live page libraries did not load', error)
        if (current) callbacks.current.onStop('libraries')
      },
    )
    return () => {
      current = false
      if (pendingHeight.current) clearTimeout(pendingHeight.current)
    }
  }, [source])

  useEffect(() => {
    if (html === null) return
    const timer = setTimeout(() => {
      if (!reported.current) callbacks.current.onStop('watchdog')
    }, PHONE_LIVE_WATCHDOG_MS)
    return () => clearTimeout(timer)
  }, [html])

  const onMessage = (event: WebViewMessageEvent): void => {
    if (!rate(Date.now())) return
    const report = parsePhoneLiveMessage(event.nativeEvent.data)
    if (!report) return
    if (report.t === 'h') {
      reported.current = true
      if (pendingHeight.current) clearTimeout(pendingHeight.current)
      pendingHeight.current = setTimeout(() => callbacks.current.onHeight(report.v), 100)
    } else {
      const append = (list: string[]): string[] => (list.length >= PHONE_LIVE_MAX_REPORTS ? list : [...list, report.v])
      if (report.t === 'e') setErrors(append)
      else setBlocked(append)
    }
  }

  if (html === null) return <Text style={styles.note}>Starting...</Text>
  const reports = [
    errors.length > 0 ? `${errors.length} ${errors.length === 1 ? 'error' : 'errors'}` : null,
    blocked.length > 0 ? `${blocked.length} blocked` : null,
  ].filter((part) => part !== null)
  return (
    <>
      <WebView
        testID="html-live-webview"
        source={{ html }}
        style={styles.web}
        originWhitelist={LIVE_ORIGIN_WHITELIST}
        onShouldStartLoadWithRequest={gate}
        onLoadStart={() => {
          loads.current += 1
          if (loads.current > 1) callbacks.current.onStop('reload')
        }}
        javaScriptEnabled
        javaScriptCanOpenWindowsAutomatically={false}
        incognito
        cacheEnabled={false}
        allowsLinkPreview={false}
        dataDetectorTypes="none"
        allowsInlineMediaPlayback={false}
        mediaCapturePermissionGrantType="deny"
        allowsBackForwardNavigationGestures={false}
        textInteractionEnabled={fullScreen}
        injectedJavaScriptBeforeContentLoaded={PHONE_LIVE_GUARD}
        onMessage={onMessage}
        onContentProcessDidTerminate={() => callbacks.current.onCrash()}
        scrollEnabled={fullScreen}
      />
      {fullScreen && reports.length > 0 && <Text style={styles.reports}>{reports.join(', ')}</Text>}
    </>
  )
}

const styles = StyleSheet.create({
  web: { flex: 1, backgroundColor: THEME.bg },
  note: { ...type.bodySm, color: colors.textDim, padding: space.md },
  reports: { ...type.monoSm, color: colors.textDim, padding: space.sm },
})
