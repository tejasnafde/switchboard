package app.switchboard.mobile.domain.thread

import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue
import java.security.MessageDigest

/** `HtmlLiveChannels.LOAD` answer (shared/html-live.ts `HtmlLiveState`). */
data class HtmlLiveState(
    /** A `data:image/png;base64,...` (or jpeg) still image the desktop took, or null. */
    val image: String?,
    val savedPath: String?,
)

/**
 * Port of the parts of src/shared/html-live.ts a phone needs. A phone never
 * runs the page: it shows the still image the desktop stored under [imageKey].
 */
object HtmlLivePages {
    const val FENCE = "html-live"
    const val CAPABILITY = "html_live_images_v1"
    /** Height of the folded image, as the desktop's folded frame. */
    const val MAX_HEIGHT = 480
    private const val MAX_TITLE_CHARS = 120
    private val titlePattern = Regex("\\btitle=(?:\"([^\"]*)\"|'([^']*)')")
    private val imagePattern = Regex("^data:image/(png|jpeg);base64,([A-Za-z0-9+/]+=*)$")

    data class Info(val title: String?)

    /** `html-live title="Chart"` -> Info("Chart"); null when the info string is another language. */
    fun parseInfo(info: String): Info? {
        val trimmed = info.trim()
        if (trimmed.split(Regex("\\s+")).firstOrNull()?.lowercase() != FENCE) return null
        val match = titlePattern.find(trimmed)
        val raw = match?.groups?.get(1)?.value ?: match?.groups?.get(2)?.value ?: ""
        return Info(raw.trim().take(MAX_TITLE_CHARS).ifEmpty { null })
    }

    /** Lowercase hex SHA-256 of the source's UTF-8 bytes: the key the desktop stores the image under. */
    fun imageKey(source: String): String =
        MessageDigest.getInstance("SHA-256").digest(source.toByteArray(Charsets.UTF_8))
            .joinToString("") { byte -> (byte.toInt() and 0xff).toString(16).padStart(2, '0') }

    /** The base64 payload of a PNG or JPEG data URL, or null for anything else. */
    fun imageBase64(dataUrl: String): String? = imagePattern.matchEntire(dataUrl)?.groupValues?.get(2)

    fun decodeState(value: JsonValue?): HtmlLiveState {
        val obj = value as? JsonObject ?: return HtmlLiveState(null, null)
        val image = (obj.values["image"] as? JsonString)?.value?.takeIf { imageBase64(it) != null }
        return HtmlLiveState(image, (obj.values["savedPath"] as? JsonString)?.value)
    }

    const val OPENED = "Opened on your Mac"
    const val UNREACHABLE = "Could not reach your Mac"

    /** The line shown for an OPEN_ON_DESKTOP answer: the backend's own error (a rate limit) when it sends one. */
    fun decodeOpened(value: JsonValue?): String {
        val obj = value as? JsonObject ?: return UNREACHABLE
        if ((obj.values["ok"] as? JsonBoolean)?.value == true) return OPENED
        return (obj.values["error"] as? JsonString)?.value ?: UNREACHABLE
    }

    /** `HtmlLiveOpenRequest`: what OPEN_ON_DESKTOP sends. */
    fun openRequest(conversationId: String, source: String, title: String?): JsonObject = JsonObject(
        linkedMapOf(
            "conversationId" to JsonString(conversationId),
            "source" to JsonString(source),
            "title" to (title?.let(::JsonString) ?: JsonNull),
        ),
    )
}

/** A page's palette as `--sb-*` variables (shared/html-live.ts `HtmlLiveTheme`). */
data class HtmlLiveTheme(
    val scheme: String,
    val bg: String,
    val surface: String,
    val text: String,
    val muted: String,
    val border: String,
    val accent: String,
    val success: String,
    val warning: String,
    val error: String,
    val font: String,
    val mono: String,
    val radius: String,
    val chart: List<String>,
)

/**
 * Port of src/shared/html-live-phone.ts for Android: run a closed ```html-live
 * block from the message text in a locked-down WebView, at a per-page
 * `https://<token>.sb-live.invalid/` origin served from `shouldInterceptRequest`.
 * The page is untrusted: the CSP header, the WebView settings and the native
 * callbacks are the sandbox. [document] is held equal to the TS builder by
 * tests/fixtures/html-live-phone-document.json.
 */
object HtmlLivePhone {
    /** Settings > Labs switch; its default is `BuildConfig.PHONE_HTML_LIVE_RUN`. */
    const val FLAG = "phone_html_live_run"
    const val HOST_SUFFIX = ".sb-live.invalid"
    const val DOCUMENT_PATH = "/index.html"
    const val LIBRARY_PREFIX = "/_sb/"
    const val HEIGHT_MARKER = "__sb_live_height__:"
    const val BLOCKED_MARKER = "__sb_live_blocked__:"
    const val MAX_BYTES = 128 * 1024
    const val MIN_HEIGHT = 120
    const val MAX_HEIGHT = 480
    const val AUTO_RUN_MIN_RAM_BYTES = 3L * 1024 * 1024 * 1024
    const val MIN_VISIBLE = 0.5f
    const val STILL_MS = 300L
    const val WATCHDOG_MS = 8_000L
    const val MAX_CRASHES = 2
    const val MAX_LINES_PER_S = 100
    const val MAX_REPORTS = 20
    const val DESKTOP_ONLY_NOTE = "Diagrams in live pages run on your Mac. Use a mermaid block to draw it here."

    val CSP = listOf(
        "default-src 'none'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:",
        "style-src 'self' 'unsafe-inline' data:",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self' data: blob:",
        "worker-src blob:",
        "media-src 'none'",
        "object-src 'none'",
        "frame-src 'none'",
        "child-src blob:",
        "form-action 'none'",
        "base-uri 'none'",
    ).joinToString("; ")

    /** Every library a page may name, by path below /_sb/, with its header label. */
    private val LIBRARIES = linkedMapOf(
        "chart.js" to "Chart.js",
        "d3.js" to "D3",
        "three.js" to "Three.js",
        "three/addons/controls/OrbitControls.js" to "Three.js",
        "mermaid.js" to "Mermaid",
    )

    /** Libraries the phone does not ship: a page that names one shows its still image. */
    private val DESKTOP_ONLY = setOf("mermaid.js")

    /** Shipped libraries, as assets at their /_sb/ paths. */
    val SHIPPED: Set<String> = LIBRARIES.keys - DESKTOP_ONLY

    /** The phone palette, as the fixture's theme. */
    val THEME = HtmlLiveTheme(
        scheme = "dark",
        bg = "#161B22",
        surface = "#21262D",
        text = "#E6EDF3",
        muted = "#8B949E",
        border = "rgba(255,255,255,0.14)",
        accent = "#58A6FF",
        success = "#3FB950",
        warning = "#D29922",
        error = "#F85149",
        font = "sans-serif",
        mono = "monospace",
        radius = "6px",
        chart = listOf("#58A6FF", "#3FB950", "#D29922", "#BC8CFF", "#39C5CF", "#DB61A2"),
    )

    sealed interface Verdict {
        data class Ok(val libraries: List<String>) : Verdict
        data object Open : Verdict
        data class TooLarge(val bytes: Int) : Verdict
        data class UnknownLibrary(val names: List<String>) : Verdict
        data class DesktopOnly(val names: List<String>) : Verdict
    }

    private val sbRef = Regex("/_sb/([A-Za-z0-9._/-]*)")
    private val threeImport = Regex("\\bfrom\\s*['\"](three(?:/addons/[A-Za-z0-9._/-]+)?)['\"]")

    /** Every /_sb/ path the page names, plus the `three` import names, in order, once each. */
    fun libraryRefs(source: String): List<String> {
        val refs = LinkedHashSet<String>()
        sbRef.findAll(source).forEach { refs += it.groupValues[1] }
        threeImport.findAll(source).forEach { refs += if (it.groupValues[1] == "three") "three.js" else it.groupValues[1] }
        return refs.toList()
    }

    /** Whether the phone runs a block: closed, under the cap, every library known and shipped. */
    fun verdict(source: String, closed: Boolean): Verdict {
        if (!closed) return Verdict.Open
        val bytes = source.toByteArray(Charsets.UTF_8).size
        if (bytes > MAX_BYTES) return Verdict.TooLarge(bytes)
        val refs = libraryRefs(source)
        val unknown = refs.filter { it !in LIBRARIES }
        if (unknown.isNotEmpty()) return Verdict.UnknownLibrary(unknown)
        val desktopOnly = refs.filter { it in DESKTOP_ONLY }
        if (desktopOnly.isNotEmpty()) return Verdict.DesktopOnly(desktopOnly)
        return Verdict.Ok(refs.map { LIBRARIES.getValue(it) }.distinct())
    }

    /** Frame height in dp for a reported content height, 120 to 480. */
    fun frameHeight(contentHeight: Double): Int =
        (if (contentHeight.isFinite()) kotlin.math.ceil(contentHeight).toInt() else 0).coerceIn(MIN_HEIGHT, MAX_HEIGHT)

    /** Under 3 GB of RAM, or a low-RAM device: a page waits for Run. */
    fun lowRam(totalBytes: Long, systemLowRam: Boolean): Boolean = systemLowRam || totalBytes < AUTO_RUN_MIN_RAM_BYTES

    fun origin(token: String) = "https://$token$HOST_SUFFIX"

    fun documentUrl(token: String) = origin(token) + DOCUMENT_PATH

    /** What `shouldInterceptRequest` answers. */
    sealed interface LiveRequest {
        /** The page document, once per token. */
        data object Document : LiveRequest
        /** A shipped library; [path] is its asset path. */
        data class Library(val path: String) : LiveRequest {
            val mime: String get() = "text/javascript"
        }
        /** A second document request: 404, and the page stops. */
        data object Reload : LiveRequest
        /** Anything else: 403 with an empty body, recorded as blocked. */
        data object Blocked : LiveRequest
    }

    /**
     * The answer to one request from the page with origin `https://<token>.sb-live.invalid`.
     * Only the document (once) and the shipped libraries on that exact origin get bytes.
     */
    fun liveRequestDecision(url: String, token: String, documentServed: Boolean): LiveRequest {
        if (token.isEmpty()) return LiveRequest.Blocked
        val uri = runCatching { java.net.URI(url) }.getOrNull() ?: return LiveRequest.Blocked
        if (!uri.scheme.equals("https", ignoreCase = true)) return LiveRequest.Blocked
        if (uri.rawUserInfo != null || (uri.port != -1 && uri.port != 443)) return LiveRequest.Blocked
        if (!uri.host.equals(token + HOST_SUFFIX, ignoreCase = true)) return LiveRequest.Blocked
        val path = uri.rawPath ?: return LiveRequest.Blocked
        if (path == DOCUMENT_PATH) return if (documentServed) LiveRequest.Reload else LiveRequest.Document
        val library = path.removePrefix(LIBRARY_PREFIX)
        return if (path.startsWith(LIBRARY_PREFIX) && library in SHIPPED) LiveRequest.Library(library) else LiveRequest.Blocked
    }

    /** What a page reports on the console: a content height, an error line or a blocked URL. */
    sealed interface Report {
        data class Height(val px: Double) : Report
        data class Error(val text: String) : Report
        data class Blocked(val url: String) : Report
    }

    /** One console line, read the way the guard writes it. */
    fun parseConsole(message: String, isError: Boolean): Report? = when {
        message.startsWith(HEIGHT_MARKER) ->
            message.removePrefix(HEIGHT_MARKER).trim().toDoubleOrNull()?.takeIf { it.isFinite() && it >= 0 }?.let(Report::Height)
        message.startsWith(BLOCKED_MARKER) -> Report.Blocked(message.removePrefix(BLOCKED_MARKER).take(300))
        isError -> Report.Error(message.take(300))
        else -> null
    }

    /**
     * A page's console, read at most [MAX_LINES_PER_S] lines in each wall-clock
     * second, keeping at most [MAX_REPORTS] error lines and blocked URLs. Main thread only.
     */
    class Reports {
        private var second = -1L
        private var count = 0
        val errors = mutableListOf<String>()
        val blocked = mutableListOf<String>()

        fun console(message: String, isError: Boolean, nowMs: Long): Report? {
            val s = nowMs / 1000
            if (s != second) {
                second = s
                count = 0
            }
            if (++count > MAX_LINES_PER_S) return null
            val report = parseConsole(message, isError) ?: return null
            when (report) {
                is Report.Error -> if (errors.size < MAX_REPORTS) errors += report.text
                is Report.Blocked -> if (blocked.size < MAX_REPORTS) blocked += report.url
                is Report.Height -> Unit
            }
            return report
        }
    }

    data class Candidate(
        val id: String,
        /** The still image key: crash counts are per key. */
        val key: String,
        /** Part of the frame on screen, 0 to 1. */
        val visible: Float,
        val runPressed: Boolean,
        val fullScreen: Boolean,
    )

    /**
     * The one page the phone runs, or null (`phoneLiveRunning`). The
     * full-screen view takes the slot. Otherwise the most visible frame runs
     * once the list is still, unless it needs Run: on a low-RAM phone, and
     * after a crash. A key that crashed twice never runs again this app run.
     */
    fun running(candidates: Collection<Candidate>, listStillMs: Long, lowRam: Boolean, crashes: Map<String, Int>): String? {
        val allowed = candidates.filter { (crashes[it.key] ?: 0) < MAX_CRASHES }
        allowed.firstOrNull { it.fullScreen }?.let { return it.id }
        if (listStillMs < STILL_MS) return null
        return allowed
            .filter { it.visible >= MIN_VISIBLE && (it.runPressed || (!lowRam && (crashes[it.key] ?: 0) == 0)) }
            .maxByOrNull { it.visible }
            ?.id
    }

    /**
     * The document the WebView loads. Our bytes always come first: the CSP
     * meta, the guard, the theme, the import map and the size reporter, then
     * the page with any leading doctype removed, so no page byte runs before
     * the CSP. The libraries load from the page's own origin.
     */
    fun document(source: String, theme: HtmlLiveTheme = THEME): String {
        val scheme = if (theme.scheme == "light") "light" else "dark"
        val page = source.replace(leadingDoctype, "")
        return "<!doctype html><html data-sb-theme=\"$scheme\"><head>" +
            "<meta http-equiv=\"Content-Security-Policy\" content=\"$CSP\">" +
            "<script>$GUARD</script>" +
            head(theme, scheme) +
            "<style>body{overflow-x:auto}</style>" +
            "</head><body>$page</body></html>"
    }

    private val leadingDoctype = Regex("^\\uFEFF?\\s*<!doctype[^>]*>", RegexOption.IGNORE_CASE)

    private fun safeCssValue(value: String): String? {
        val v = value.trim()
        return v.takeIf { it.isNotEmpty() && it.length <= 200 && it.none { c -> c in "<>;{}\\" } }
    }

    /** `htmlLiveHead`: theme variables, viewport, import map and size reporter. */
    private fun head(theme: HtmlLiveTheme, scheme: String): String {
        val named = listOf(
            "--sb-bg" to theme.bg,
            "--sb-surface" to theme.surface,
            "--sb-text" to theme.text,
            "--sb-muted" to theme.muted,
            "--sb-border" to theme.border,
            "--sb-accent" to theme.accent,
            "--sb-success" to theme.success,
            "--sb-warning" to theme.warning,
            "--sb-error" to theme.error,
            "--sb-font" to theme.font,
            "--sb-mono" to theme.mono,
            "--sb-radius" to theme.radius,
        )
        val chart = theme.chart.take(6).mapIndexed { i, color -> "--sb-chart-${i + 1}" to color }
        val vars = (named + chart).joinToString("") { (name, raw) -> safeCssValue(raw)?.let { "$name:$it;" } ?: "" }
        return "<meta charset=\"utf-8\">" +
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
            "<style>:root{${vars}color-scheme:$scheme}html,body{margin:0;background:var(--sb-bg);color:var(--sb-text);font:13px/1.45 var(--sb-font,sans-serif)}body{padding:10px}</style>" +
            "<script type=\"importmap\">{\"imports\":{\"three\":\"/_sb/three.js\",\"three/addons/\":\"/_sb/three/addons/\"}}</script>" +
            "<script>document.documentElement.dataset.sbTheme='$scheme';$SIZE_REPORTER</script>"
    }

    private const val SIZE_REPORTER = """(() => {
  let last = -1
  const post = () => {
    const h = Math.ceil(document.documentElement.getBoundingClientRect().height)
    if (h !== last) { last = h; console.info('__sb_live_height__:' + h) }
  }
  addEventListener('DOMContentLoaded', post)
  addEventListener('load', () => { post(); new ResizeObserver(post).observe(document.documentElement) })
})()"""

    /**
     * Runs before any page code (`PHONE_LIVE_GUARD`). Best effort: removes
     * WebRTC, notifications and service workers, reports CSP violations on the
     * console, and caps page console output at 50 lines a second.
     */
    private const val GUARD = """(() => {
  const off = function () { throw new Error('WebRTC is off in live pages') }
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel']) {
    try { Object.defineProperty(window, name, { value: off, writable: false, configurable: false }) } catch (e) {}
  }
  try { Object.defineProperty(window, 'Notification', { value: undefined, writable: false, configurable: false }) } catch (e) {}
  try {
    if (navigator.serviceWorker) {
      Object.defineProperty(navigator.serviceWorker, 'register', { value: () => Promise.reject(new Error('off')), writable: false, configurable: false })
    }
  } catch (e) {}
  const bridge = window.ReactNativeWebView
  const H = '__sb_live_height__:', B = '__sb_live_blocked__:'
  const gate = () => {
    let second = 0, sent = 0
    return () => {
      const now = Math.floor(Date.now() / 1000)
      if (now !== second) { second = now; sent = 0 }
      return ++sent <= 50
    }
  }
  const pageLines = gate(), ownLines = gate()
  const str = (a) => { try { return String(a) } catch (e) { return '[object]' } }
  const post = (t, v) => bridge.postMessage(JSON.stringify({ t, v: typeof v === 'string' ? v.slice(0, 300) : v }))
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level].bind(console)
    console[level] = (...args) => {
      const first = typeof args[0] === 'string' ? args[0] : ''
      const own = first.startsWith(H) || first.startsWith(B)
      if (!(own ? ownLines() : pageLines())) return
      if (!bridge) return original(...args)
      if (first.startsWith(H)) post('h', Number(first.slice(H.length)))
      else if (first.startsWith(B)) post('b', first.slice(B.length))
      else if (level === 'error') post('e', args.map(str).join(' '))
    }
  }
  addEventListener('securitypolicyviolation', (e) => console.warn(B + e.blockedURI))
  if (bridge) {
    addEventListener('error', (e) => { if (pageLines()) post('e', str(e.message)) })
    addEventListener('unhandledrejection', (e) => { if (pageLines()) post('e', str(e.reason)) })
  }
})()"""
}
