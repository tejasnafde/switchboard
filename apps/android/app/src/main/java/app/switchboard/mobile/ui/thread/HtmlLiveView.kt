package app.switchboard.mobile.ui.thread

import android.app.ActivityManager
import android.content.Context
import android.content.res.AssetManager
import android.graphics.Color as AndroidColor
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.util.Log
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewRenderProcess
import android.webkit.WebViewRenderProcessClient
import androidx.annotation.RequiresApi
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.min
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.currentStateAsState
import app.switchboard.mobile.domain.thread.HtmlLivePhone
import app.switchboard.mobile.domain.thread.HtmlLivePhone.LiveRequest
import app.switchboard.mobile.ui.theme.Background
import app.switchboard.mobile.ui.theme.TextDim
import app.switchboard.mobile.ui.theme.TextPrimary
import java.io.ByteArrayInputStream
import java.security.SecureRandom
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.delay

private const val TAG = "HtmlLiveView"

/** Settings > Labs "Run live pages" (`phone_html_live_run`). Off: the card shows only the still image. */
val LocalPhoneLiveRun = staticCompositionLocalOf { false }

/** Whether this phone waits for Run before a page runs; null reads the device. */
val LocalPhoneLiveLowRam = staticCompositionLocalOf<Boolean?> { null }

/** Why a running page stopped. Each counts toward the two-stop limit of its key. */
enum class LiveStop { CRASHED, RELOAD, WATCHDOG }

/** What a running page tells its card. Main thread. */
internal interface LivePageListener {
    fun onReport(report: HtmlLivePhone.Report)
    fun onStop(reason: LiveStop)
}

private val noHeaders = emptyMap<String, String>()
private val libraryHeaders = mapOf("X-Content-Type-Options" to "nosniff", "Cache-Control" to "no-store")
private val documentHeaders = mapOf("Content-Security-Policy" to HtmlLivePhone.CSP) + libraryHeaders

private fun emptyResponse(status: Int, reason: String) =
    WebResourceResponse("text/plain", "utf-8", status, reason, noHeaders, ByteArrayInputStream(ByteArray(0)))

/**
 * Serves one page at `https://<token>.sb-live.invalid/`: the document once,
 * the shipped libraries from the assets, and an empty 403 for anything else.
 * A second document request is a reload: 404, and the page stops.
 */
internal class LiveWebViewClient(
    private val token: String,
    private val document: String,
    private val assets: AssetManager,
    private val listener: LivePageListener,
) : LockedDownWebViewClient(onGone = { listener.onStop(LiveStop.CRASHED) }) {
    private val served = AtomicBoolean(false)
    private val reloaded = AtomicBoolean(false)
    // Same-origin requests pass the CSP, so a page can flood the intercept: tell the card about the first few only.
    private val blockedReports = AtomicInteger(0)
    private val main = Handler(Looper.getMainLooper())

    // Called on a WebView thread, not the main thread.
    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse =
        respond(request.url.toString())

    fun respond(url: String): WebResourceResponse {
        var decision = HtmlLivePhone.liveRequestDecision(url, token, served.get())
        if (decision == LiveRequest.Document && !served.compareAndSet(false, true)) decision = LiveRequest.Reload
        return when (decision) {
            LiveRequest.Document ->
                WebResourceResponse("text/html", "utf-8", 200, "OK", documentHeaders, ByteArrayInputStream(document.toByteArray(Charsets.UTF_8)))
            is LiveRequest.Library -> runCatching { assets.open(decision.path) }
                .onFailure { Log.w(TAG, "live library asset missing: ${decision.path}", it) }
                .getOrNull()
                ?.let { WebResourceResponse(decision.mime, "utf-8", 200, "OK", libraryHeaders, it) }
                ?: emptyResponse(404, "Not Found")
            LiveRequest.Reload -> {
                if (reloaded.compareAndSet(false, true)) main.post { listener.onStop(LiveStop.RELOAD) }
                emptyResponse(404, "Not Found")
            }
            LiveRequest.Blocked -> {
                if (blockedReports.getAndIncrement() < HtmlLivePhone.MAX_REPORTS) {
                    main.post { listener.onReport(HtmlLivePhone.Report.Blocked(url.take(300))) }
                }
                emptyResponse(403, "Forbidden")
            }
        }
    }

    // There is no real TLS here: the origin never reaches the network.
    override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
        handler.cancel()
    }
}

/**
 * Reads height, errors and blocked URLs from the console (no JavaScript
 * bridge), at most 100 lines a second, and refuses windows, permissions,
 * location, file choosers and dialogs.
 */
internal class LiveChromeClient(
    private val listener: LivePageListener,
    private val clock: () -> Long = System::currentTimeMillis,
) : WebChromeClient() {
    val reports = HtmlLivePhone.Reports()

    override fun onConsoleMessage(message: ConsoleMessage): Boolean {
        reports.console(message.message(), message.messageLevel() == ConsoleMessage.MessageLevel.ERROR, clock())
            ?.let(listener::onReport)
        return true
    }

    override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message?) = false

    override fun onPermissionRequest(request: PermissionRequest) = request.deny()

    override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback) =
        callback.invoke(origin, false, false)

    override fun onShowFileChooser(
        view: WebView,
        filePathCallback: ValueCallback<Array<Uri>>?,
        fileChooserParams: FileChooserParams?,
    ) = false

    override fun onJsAlert(view: WebView, url: String?, message: String?, result: JsResult) = cancel(result)

    override fun onJsConfirm(view: WebView, url: String?, message: String?, result: JsResult) = cancel(result)

    override fun onJsPrompt(view: WebView, url: String?, message: String?, defaultValue: String?, result: JsPromptResult) =
        cancel(result)

    override fun onJsBeforeUnload(view: WebView, url: String?, message: String?, result: JsResult) = cancel(result)

    private fun cancel(result: JsResult): Boolean {
        result.cancel()
        return true
    }
}

private val random = SecureRandom()

/** 128 random bits as hex: the page's own origin, new for every run. */
internal fun newLiveToken(): String = ByteArray(16).also(random::nextBytes).joinToString("") { "%02x".format(it) }

/**
 * Stops a page whose renderer stops answering. It never calls `terminate()`:
 * the diagram cards share that renderer. The card destroys this one view.
 */
@RequiresApi(Build.VERSION_CODES.Q)
internal class LiveRenderProcessClient(private val listener: LivePageListener) : WebViewRenderProcessClient() {
    override fun onRenderProcessUnresponsive(view: WebView, renderer: WebViewRenderProcess?) {
        Log.w(TAG, "live page renderer unresponsive")
        listener.onStop(LiveStop.WATCHDOG)
    }

    override fun onRenderProcessResponsive(view: WebView, renderer: WebViewRenderProcess?) = Unit
}

/** A locked-down WebView that loads one live page from its own origin. Throws when the WebView is missing. */
internal fun liveWebView(context: Context, token: String, source: String, listener: LivePageListener): WebView {
    val client = LiveWebViewClient(token, HtmlLivePhone.document(source), context.assets, listener)
    return lockedDownWebView(context, client).apply {
        webChromeClient = LiveChromeClient(listener)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            setWebViewRenderProcessClient(context.mainExecutor, LiveRenderProcessClient(listener))
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(this, false)
        setBackgroundColor(AndroidColor.TRANSPARENT)
        loadUrl(HtmlLivePhone.documentUrl(token))
    }
}

/**
 * The app's one running live page. Cards register as candidates; the
 * full-screen view takes the slot, else the most visible card once the list
 * is still. Stops and crash counts are per key for this app run.
 */
internal object LivePages {
    val candidates = mutableStateMapOf<String, HtmlLivePhone.Candidate>()
    val stops = mutableStateMapOf<String, Int>()
    var movedAt by mutableLongStateOf(0L)
    var still by mutableStateOf(false)
    /** A WebView constructor threw (no WebView provider): nothing runs this app run. */
    var unavailable by mutableStateOf(false)

    fun running(lowRam: Boolean): String? =
        if (unavailable) null else HtmlLivePhone.running(candidates.values, if (still) Long.MAX_VALUE else 0L, lowRam, stops)

    fun canRun(key: String) = !unavailable && (stops[key] ?: 0) < HtmlLivePhone.MAX_CRASHES

    fun moved() {
        still = false
        movedAt = System.nanoTime()
    }

    fun stopped(key: String) {
        stops[key] = (stops[key] ?: 0) + 1
    }

    /** Tests only: a fresh app run. */
    fun reset() {
        candidates.clear()
        stops.clear()
        still = false
        unavailable = false
    }
}

@Composable
private fun deviceLowRam(): Boolean {
    LocalPhoneLiveLowRam.current?.let { return it }
    val context = LocalContext.current
    return remember {
        val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val memory = ActivityManager.MemoryInfo().also(manager::getMemoryInfo)
        HtmlLivePhone.lowRam(memory.totalMem, manager.isLowRamDevice)
    }
}

/** A frame that runs one page with an 8 s watchdog. The WebView is destroyed when this leaves composition. */
@Composable
private fun LiveFrame(source: String, modifier: Modifier, onReport: (HtmlLivePhone.Report) -> Unit, onStop: (LiveStop) -> Unit) {
    val token = remember { newLiveToken() }
    var heard by remember { mutableStateOf(false) }
    var ended by remember { mutableStateOf(false) }
    val report by rememberUpdatedState(onReport)
    val stopOnce by rememberUpdatedState(onStop)
    // A frame stops once: a crash after the watchdog must not count twice.
    val stop: (LiveStop) -> Unit = { reason ->
        if (!ended) {
            ended = true
            stopOnce(reason)
        }
    }
    LaunchedEffect(token) {
        delay(HtmlLivePhone.WATCHDOG_MS)
        if (!heard) stop(LiveStop.WATCHDOG)
    }
    AndroidView(
        modifier = modifier,
        factory = { context ->
            val listener = object : LivePageListener {
                override fun onReport(report: HtmlLivePhone.Report) {
                    if (report is HtmlLivePhone.Report.Height) heard = true
                    report(report)
                }

                override fun onStop(reason: LiveStop) = stop(reason)
            }
            runCatching { liveWebView(context, token, source, listener) }
                .onFailure {
                    Log.w(TAG, "WebView unavailable", it)
                    LivePages.unavailable = true
                }
                .getOrElse { View(context) }
        },
        onRelease = { (it as? WebView)?.destroy() },
    )
}

/**
 * The live area of a card: the page while it holds the run slot, else the
 * still image (or [placeholder]) at the same height, so a swap never moves
 * the list. A transparent overlay takes every touch inline: a tap opens the
 * full-screen view, which gets the gestures.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun LivePage(
    key: String,
    source: String,
    name: String,
    still: ImageBitmap?,
    placeholder: String,
    onLongPress: () -> Unit,
    onZoomStill: () -> Unit,
) {
    val id = remember { UUID.randomUUID().toString() }
    val fullId = "$id/full"
    val lowRam = deviceLowRam()
    val resumed = LocalLifecycleOwner.current.lifecycle.currentStateAsState().value.isAtLeast(Lifecycle.State.RESUMED)
    var visible by remember { mutableFloatStateOf(0f) }
    var top by remember { mutableFloatStateOf(Float.NaN) }
    var runPressed by remember { mutableStateOf(false) }
    var fullScreen by remember { mutableStateOf(false) }
    var contentHeight by remember { mutableDoubleStateOf(0.0) }
    var blocked by remember { mutableIntStateOf(0) }
    var errors by remember { mutableIntStateOf(0) }
    val stops = LivePages.stops[key] ?: 0

    DisposableEffect(id) {
        onDispose {
            LivePages.candidates.remove(id)
            LivePages.candidates.remove(fullId)
        }
    }
    val inline = HtmlLivePhone.Candidate(id, key, if (resumed) visible else 0f, runPressed, fullScreen = false)
    val full = HtmlLivePhone.Candidate(fullId, key, 1f, runPressed = true, fullScreen = true).takeIf { fullScreen && resumed }
    SideEffect {
        // Write only on a change: an equal write would recompose every card again.
        if (LivePages.candidates[id] != inline) LivePages.candidates[id] = inline
        if (full == null) {
            if (fullId in LivePages.candidates) LivePages.candidates.remove(fullId)
        } else if (LivePages.candidates[fullId] != full) {
            LivePages.candidates[fullId] = full
        }
    }
    LaunchedEffect(LivePages.movedAt) {
        delay(HtmlLivePhone.STILL_MS)
        LivePages.still = true
    }

    val running = LivePages.running(lowRam)
    val onReport: (HtmlLivePhone.Report) -> Unit = { report ->
        when (report) {
            is HtmlLivePhone.Report.Height -> contentHeight = report.px
            is HtmlLivePhone.Report.Error -> errors = (errors + 1).coerceAtMost(HtmlLivePhone.MAX_REPORTS)
            is HtmlLivePhone.Report.Blocked -> blocked = (blocked + 1).coerceAtMost(HtmlLivePhone.MAX_REPORTS)
        }
    }
    val onStop: (LiveStop) -> Unit = { reason ->
        Log.w(TAG, "live page stopped: $reason")
        LivePages.stopped(key)
        runPressed = false
        fullScreen = false
    }

    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val stillHeight: Dp = still?.let { min(maxWidth * (it.height.toFloat() / it.width.coerceAtLeast(1)), HtmlLivePhone.MAX_HEIGHT.dp) } ?: 160.dp
        val height = if (contentHeight > 0) HtmlLivePhone.frameHeight(contentHeight).dp else stillHeight
        Box(
            Modifier
                .fillMaxWidth()
                .height(height)
                .clipToBounds()
                .onGloballyPositioned { coordinates ->
                    val size = coordinates.size.height
                    visible = if (size > 0) (coordinates.boundsInWindow().height / size).coerceIn(0f, 1f) else 0f
                    val y = coordinates.positionInWindow().y
                    if (y != top) {
                        top = y
                        LivePages.moved()
                    }
                },
        ) {
            if (running == id) {
                LiveFrame(source, Modifier.matchParentSize(), onReport, onStop)
            } else if (still != null) {
                Image(
                    bitmap = still,
                    contentDescription = "Still image of $name",
                    contentScale = ContentScale.FillWidth,
                    alignment = Alignment.TopCenter,
                    modifier = Modifier.fillMaxWidth(),
                )
            } else {
                LiveMuted(placeholder)
            }
            Box(
                Modifier
                    .matchParentSize()
                    .combinedClickable(
                        onClickLabel = "Open live page",
                        onLongClickLabel = "Show actions",
                        onClick = { if (LivePages.canRun(key)) fullScreen = true else if (still != null) onZoomStill() },
                        onLongClick = onLongPress,
                    ),
            )
        }
    }
    val canRun = LivePages.canRun(key)
    // Read from the per-key count, so the state survives the card leaving the list.
    val stopped = stops > 0 && !runPressed && running != id
    when {
        stopped -> Row(verticalAlignment = Alignment.CenterVertically) {
            LiveMuted("This page stopped.", Modifier.weight(1f))
            if (canRun) {
                TextButton(onClick = { runPressed = true }) { Text("Run again", color = TextPrimary, fontSize = 12.sp) }
            }
        }
        canRun && lowRam && !runPressed && running != id -> Row(verticalAlignment = Alignment.CenterVertically) {
            LiveMuted("Runs on tap on this phone.", Modifier.weight(1f))
            TextButton(onClick = { runPressed = true }) { Text("Run", color = TextPrimary, fontSize = 12.sp) }
        }
    }
    if (blocked > 0 || errors > 0) LiveMuted("No network here. Blocked: $blocked. Errors: $errors.")

    if (fullScreen) {
        Dialog(onDismissRequest = { fullScreen = false }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
            Column(Modifier.fillMaxSize().background(Background)) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .statusBarsPadding()
                        .heightIn(min = 56.dp)
                        .padding(start = 16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(name, color = TextPrimary, fontSize = 16.sp, maxLines = 1)
                        Text("Live page from the agent", color = TextDim, fontSize = 12.sp)
                    }
                    TextButton(onClick = { fullScreen = false }) { Text("Close", color = TextPrimary) }
                }
                Box(Modifier.fillMaxSize().semantics { contentDescription = "Live page: $name, full screen" }) {
                    if (running == fullId) LiveFrame(source, Modifier.fillMaxSize(), onReport, onStop)
                }
            }
        }
    }
}

@Composable
private fun LiveMuted(text: String, modifier: Modifier = Modifier) {
    Text(text, color = TextDim, fontSize = 12.sp, modifier = modifier.padding(10.dp))
}
