package app.switchboard.mobile.ui.thread

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.Context
import android.net.Uri
import android.util.Log
import android.webkit.WebMessage
import android.webkit.WebMessagePort
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import app.switchboard.mobile.domain.thread.ChartParse
import app.switchboard.mobile.domain.thread.ChatVisuals
import app.switchboard.mobile.domain.thread.VisualKind
import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.ui.theme.Accent
import app.switchboard.mobile.ui.theme.Amber
import app.switchboard.mobile.ui.theme.GeistMono
import app.switchboard.mobile.ui.theme.Green
import app.switchboard.mobile.ui.theme.Red
import app.switchboard.mobile.ui.theme.SurfaceRaised
import app.switchboard.mobile.ui.theme.SurfaceSoft
import app.switchboard.mobile.ui.theme.TextDim
import app.switchboard.mobile.ui.theme.TextPrimary
import java.io.ByteArrayInputStream
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private const val TAG = "ChatVisual"

private sealed interface VisualState {
    data object Drawing : VisualState
    data class Drawn(val heightDp: Int, val svg: String) : VisualState
    data class Failed(val error: String) : VisualState
}

/** Drawn heights by source, so a row scrolled back into view does not jump. */
private val drawnCache = object : LinkedHashMap<String, VisualState.Drawn>(16, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, VisualState.Drawn>?) = size > 50
}

@Volatile
private var hostHtml: String? = null

private suspend fun loadHostHtml(context: Context): String = hostHtml ?: withContext(Dispatchers.IO) {
    context.assets.open("visual-host.html").bufferedReader().use { it.readText() }
}.also { hostHtml = it }

/**
 * `#RRGGBB` for the page's theme. Locale.ROOT keeps the digits ASCII: the page's
 * colour check rejects anything else, so a localised format would fail every visual.
 */
internal fun visualColorHex(argb: Int): String = String.format(Locale.ROOT, "#%06X", argb and 0xFFFFFF)

private fun hex(color: Color) = visualColorHex(color.toArgb())

/** The request the bundled page draws: the source travels as JSON data, never as markup. */
private fun requestJson(kind: VisualKind, source: String): String = JsonCodec.encode(
    JsonObject(
        linkedMapOf(
            "kind" to JsonString(kind.wire),
            "source" to JsonString(source),
            "theme" to JsonObject(
                linkedMapOf(
                    "dark" to JsonBoolean(true),
                    "background" to JsonString(hex(SurfaceRaised)),
                    "surface" to JsonString(hex(SurfaceSoft)),
                    "text" to JsonString(hex(TextPrimary)),
                    "muted" to JsonString(hex(TextDim)),
                    "line" to JsonString(hex(TextDim)),
                    "border" to JsonString("rgba(255,255,255,0.14)"),
                    "font" to JsonString("sans-serif"),
                    "series" to JsonArray(
                        listOf(Accent, Green, Amber, Color(0xFFBC8CFF), Color(0xFF39C5CF), Color(0xFFDB61A2), Red, TextDim)
                            .map { JsonString(hex(it)) },
                    ),
                ),
            ),
        ),
    ),
)

/** Reads the page's one answer; anything else it might send is ignored. */
private fun parseAnswer(data: String?): VisualState? {
    val answer = runCatching { JsonCodec.parse(data ?: return null) as? JsonObject }.getOrNull() ?: return null
    return when ((answer.values["type"] as? JsonString)?.value) {
        "drawn" -> {
            val height = (answer.values["height"] as? JsonNumber)?.source?.toDoubleOrNull() ?: return null
            val svg = (answer.values["svg"] as? JsonString)?.value ?: return null
            VisualState.Drawn(height.toInt().coerceIn(24, 1200), svg)
        }
        "error" -> VisualState.Failed((answer.values["error"] as? JsonString)?.value ?: "It could not be drawn.")
        else -> null
    }
}

@Composable
fun ChatVisualCard(kind: VisualKind, source: String) {
    val context = LocalContext.current
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    val cacheKey = "${kind.wire}\n$source"
    val chart = remember(kind, source) { if (kind == VisualKind.CHART) ChatVisuals.parseChartSpec(source) else null }
    var state by remember(cacheKey) { mutableStateOf<VisualState>(synchronized(drawnCache) { drawnCache[cacheKey] } ?: VisualState.Drawing) }
    var html by remember { mutableStateOf(hostHtml) }
    var showSource by remember { mutableStateOf(false) }
    val invalid = (chart as? ChartParse.Invalid)?.error ?: (state as? VisualState.Failed)?.error
    val noun = if (kind == VisualKind.MERMAID) "Diagram" else "Chart"

    LaunchedEffect(invalid) {
        if (invalid != null || html != null) return@LaunchedEffect
        html = runCatching { loadHostHtml(context) }.onFailure { Log.w(TAG, "visual host did not load", it) }.getOrNull()
        if (html == null) state = VisualState.Failed("This app version cannot draw it.")
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(SurfaceRaised),
    ) {
        Row(
            modifier = Modifier.padding(start = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(noun, color = TextDim, fontSize = 12.sp, modifier = Modifier.weight(1f))
            if (invalid == null) {
                TextButton(onClick = { showSource = !showSource }) { Text("Source", color = TextDim, fontSize = 12.sp) }
            }
            val copyText = when {
                invalid != null -> null
                chart is ChartParse.Ok -> ChatVisuals.chartDataText(chart.spec)
                else -> (state as? VisualState.Drawn)?.svg
            }
            if (copyText != null) {
                TextButton(onClick = { scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText(noun, copyText))) } }) {
                    Text(if (kind == VisualKind.MERMAID) "Copy SVG" else "Copy data", color = TextDim, fontSize = 12.sp)
                }
            }
        }
        if (invalid != null) {
            Text(
                "This ${noun.lowercase()} could not be drawn: $invalid",
                color = Red,
                fontSize = 12.sp,
                modifier = Modifier.padding(horizontal = 10.dp),
            )
        }
        val page = html
        if (invalid != null || showSource) {
            Text(
                source,
                fontFamily = GeistMono,
                fontSize = 12.sp,
                color = TextPrimary,
                modifier = Modifier
                    .horizontalScroll(rememberScrollState())
                    .padding(10.dp),
            )
        } else if (page == null) {
            Text("Drawing ${noun.lowercase()}...", color = TextDim, fontSize = 12.sp, modifier = Modifier.padding(10.dp))
        } else {
            val height = (state as? VisualState.Drawn)?.heightDp ?: 160
            // A different visual gets a fresh WebView, never the old one's request.
            key(cacheKey) {
                AndroidView(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(height.dp),
                    factory = { viewContext ->
                        visualWebView(viewContext, page, requestJson(kind, source)) { answer ->
                            if (answer is VisualState.Drawn) synchronized(drawnCache) { drawnCache[cacheKey] = answer }
                            state = answer
                        }
                    },
                    onRelease = { it.destroy() },
                )
            }
        }
    }
}

/**
 * A WebView that loads only the bundled page: JavaScript on (Mermaid needs
 * it) but no file, content or network access, no navigation, no new windows
 * and no JavaScript interface. The request goes in over a message channel.
 */
@SuppressLint("SetJavaScriptEnabled")
private fun visualWebView(context: Context, page: String, request: String, onAnswer: (VisualState) -> Unit): WebView =
    WebView(context).apply {
        setBackgroundColor(SurfaceRaised.toArgb())
        isVerticalScrollBarEnabled = false
        isHorizontalScrollBarEnabled = false
        settings.apply {
            javaScriptEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            blockNetworkLoads = true
            domStorageEnabled = false
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
        }
        var sent = false
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true

            // The page itself is about:blank data; anything it would fetch is refused.
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                if (request.url.scheme == "about" || request.url.scheme == "data") {
                    null
                } else {
                    WebResourceResponse("text/plain", "utf-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
                }

            override fun onPageFinished(view: WebView, url: String?) {
                if (sent) return
                sent = true
                val (local, remote) = view.createWebMessageChannel()
                local.setWebMessageCallback(object : WebMessagePort.WebMessageCallback() {
                    override fun onMessage(port: WebMessagePort, message: WebMessage) {
                        parseAnswer(message.data)?.let(onAnswer)
                        port.close()
                    }
                })
                view.postWebMessage(WebMessage(request, arrayOf(remote)), Uri.EMPTY)
            }
        }
        loadDataWithBaseURL(null, page, "text/html", "utf-8", null)
    }
