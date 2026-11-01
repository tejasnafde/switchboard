package app.switchboard.mobile.ui.thread

import android.app.Application
import android.content.Context
import android.net.Uri
import android.net.http.SslError
import android.os.Looper
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import androidx.test.core.app.ApplicationProvider
import app.switchboard.mobile.domain.thread.HtmlLivePhone
import java.io.File
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.fakes.RoboWebSettings
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowJsResult
import org.robolectric.shadows.ShadowWebView

/** The live page WebView: every setting, every request decision, and every callback that could leave the sandbox. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class LiveWebViewTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val token = "0123456789abcdef0123456789abcdef"
    private val origin = "https://$token.sb-live.invalid"
    private val reports = mutableListOf<HtmlLivePhone.Report>()
    private val stops = mutableListOf<LiveStop>()
    private val listener = object : LivePageListener {
        override fun onReport(report: HtmlLivePhone.Report) {
            reports += report
        }

        override fun onStop(reason: LiveStop) {
            stops += reason
        }
    }

    private fun request(url: String) = object : WebResourceRequest {
        override fun getUrl(): Uri = Uri.parse(url)
        override fun isForMainFrame() = true
        override fun isRedirect() = false
        override fun hasGesture() = true
        override fun getMethod() = "GET"
        override fun getRequestHeaders() = emptyMap<String, String>()
    }

    private fun view() = liveWebView(context, token, "<p>hi</p>", listener)

    private fun idle() = shadowOf(Looper.getMainLooper()).idle()

    @Test
    fun everySettingIsLockedDown() {
        val view = view()
        with(view.settings) {
            assertTrue(javaScriptEnabled)
            assertFalse(allowFileAccess)
            assertFalse(allowContentAccess)
            @Suppress("DEPRECATION")
            assertFalse(allowFileAccessFromFileURLs)
            @Suppress("DEPRECATION")
            assertFalse(allowUniversalAccessFromFileURLs)
            assertTrue(blockNetworkLoads)
            assertFalse(domStorageEnabled)
            @Suppress("DEPRECATION")
            assertFalse(databaseEnabled)
            assertEquals(WebSettings.LOAD_NO_CACHE, cacheMode)
            assertFalse(javaScriptCanOpenWindowsAutomatically)
            assertFalse(supportMultipleWindows())
            assertTrue(mediaPlaybackRequiresUserGesture)
            assertFalse(safeBrowsingEnabled)
        }
        assertFalse((view.settings as RoboWebSettings).geolocationEnabled)
        assertFalse(CookieManager.getInstance().acceptThirdPartyCookies(view))
        // No JavaScript interface is ever added.
        val interfaces = ShadowWebView::class.java.getDeclaredField("javascriptInterfaces")
            .apply { isAccessible = true }
            .get(shadowOf(view)) as Map<*, *>
        assertTrue(interfaces.isEmpty())
        assertEquals("$origin/index.html", shadowOf(view).lastLoadedUrl)
    }

    @Test
    fun servesTheDocumentOnceWithItsHeaders() {
        val client = view().webViewClient as LiveWebViewClient
        val document = client.respond("$origin/index.html")
        assertEquals(200, document.statusCode)
        assertEquals("text/html", document.mimeType)
        assertEquals(HtmlLivePhone.CSP, document.responseHeaders["Content-Security-Policy"])
        assertEquals("nosniff", document.responseHeaders["X-Content-Type-Options"])
        assertEquals("no-store", document.responseHeaders["Cache-Control"])
        assertEquals(HtmlLivePhone.document("<p>hi</p>"), document.data.readBytes().toString(Charsets.UTF_8))

        val again = client.respond("$origin/index.html")
        assertEquals(404, again.statusCode)
        assertEquals(0, again.data.readBytes().size)
        idle()
        assertEquals(listOf(LiveStop.RELOAD), stops)
    }

    @Test
    fun theDocumentCspHeaderClosesEveryFetchPath() {
        val client = view().webViewClient as LiveWebViewClient
        val csp = client.respond("$origin/index.html").responseHeaders.getValue("Content-Security-Policy")
        val directives = csp.split(";").map { it.trim() }.associate { it.substringBefore(' ') to it.substringAfter(' ') }
        assertEquals("'none'", directives["default-src"])
        // fetch, XHR, WebSocket, EventSource and sendBeacon.
        assertEquals("'self' data: blob:", directives["connect-src"])
        // <img src>.
        assertEquals("'self' data: blob:", directives["img-src"])
        // CSS url(), @import and @font-face.
        assertEquals("'self' 'unsafe-inline' data:", directives["style-src"])
        assertEquals("'self' data:", directives["font-src"])
        assertEquals("'none'", directives["form-action"])
        assertEquals("'none'", directives["frame-src"])
        assertEquals("'none'", directives["object-src"])
        assertEquals("'none'", directives["media-src"])
        assertEquals("'none'", directives["base-uri"])
        // No directive names a network scheme or a wildcard.
        for (source in directives.values.flatMap { it.split(' ') }) {
            assertFalse(csp, source == "*" || source.startsWith("http") || source.startsWith("ws"))
        }
    }

    @Test
    fun dataAndBlobUrlsAreNeverServedByTheIntercept() {
        // The WebView does not route them here (the CSP governs them); if it did, they get no bytes.
        val client = view().webViewClient as LiveWebViewClient
        for (url in listOf("data:text/html,<p>x</p>", "data:text/javascript,1", "blob:$origin/0f0e")) {
            val response = client.respond(url)
            assertEquals(url, 403, response.statusCode)
            assertEquals(url, 0, response.data.readBytes().size)
        }
    }

    @Test
    fun servesEachShippedLibraryFromTheAssets() {
        val client = view().webViewClient as LiveWebViewClient
        for (path in listOf("chart.js", "d3.js", "three.js", "three/addons/controls/OrbitControls.js")) {
            val response = client.respond("$origin/_sb/$path")
            assertEquals(path, 200, response.statusCode)
            assertEquals("text/javascript", response.mimeType)
            assertEquals("nosniff", response.responseHeaders["X-Content-Type-Options"])
            assertArrayEquals(path, File("../../../resources/sb-live", path).readBytes(), response.data.readBytes())
        }
    }

    @Test
    fun blocksEveryOtherRequestWithAnEmpty403() {
        val view = view()
        val blocked = listOf(
            "https://example.com/",
            "http://$token.sb-live.invalid/index.html",
            "http://10.0.2.2/",
            "file:///proc/self/status",
            "content://settings/system",
            "intent://x#Intent;end",
            "https://ffffffffffffffffffffffffffffffff.sb-live.invalid/index.html",
            "wss://example.com/socket",
            "ws://10.0.2.2/",
            "https://cdn.example.com/a.png",
            "https://example.com/style.css",
            "$origin/_sb/mermaid.js",
        )
        for (url in blocked) {
            val response = view.webViewClient.shouldInterceptRequest(view, request(url))!!
            assertEquals(url, 403, response.statusCode)
            assertEquals(url, 0, response.data.readBytes().size)
        }
        idle()
        assertEquals(blocked.map { HtmlLivePhone.Report.Blocked(it) }, reports)
    }

    @Test
    fun aFloodOfBlockedRequestsReachesTheCardTwentyTimesAndAReloadOnce() {
        val client = view().webViewClient as LiveWebViewClient
        client.respond("$origin/index.html")
        repeat(500) { assertEquals(403, client.respond("$origin/x$it").statusCode) }
        repeat(5) { assertEquals(404, client.respond("$origin/index.html").statusCode) }
        idle()
        assertEquals(HtmlLivePhone.MAX_REPORTS, reports.size)
        assertEquals(listOf(LiveStop.RELOAD), stops)
    }

    @Test
    fun refusesEveryNavigationAndStartsNoActivity() {
        val view = view()
        for (url in listOf(
            "http://example.com",
            "https://example.com",
            "intent://scan/#Intent;scheme=zxing;package=x;end",
            "market://details?id=x",
            "tel:123",
            "sms:123",
            "mailto:a@example.com",
            "file:///etc/hosts",
            "content://settings/system",
            "javascript:alert(1)",
            "about:blank",
            "about:srcdoc",
            "data:text/html,<p>x</p>",
            "$origin/index.html",
        )) {
            assertTrue(url, view.webViewClient.shouldOverrideUrlLoading(view, request(url)))
        }
        assertNull(shadowOf(ApplicationProvider.getApplicationContext<Application>()).nextStartedActivity)
    }

    @Test
    fun cancelsSslErrors() {
        val view = view()
        val handler = Shadow.newInstanceOf(SslErrorHandler::class.java)
        view.webViewClient.onReceivedSslError(view, handler, Shadow.newInstanceOf(SslError::class.java))
        assertTrue(shadowOf(handler).wasCancelCalled())
    }

    @Test
    fun aLostRendererIsHandledAndStopsThePage() {
        val view = view()
        val detail = object : RenderProcessGoneDetail() {
            override fun didCrash() = true
            override fun rendererPriorityAtExit() = 0
        }
        assertTrue(view.webViewClient.onRenderProcessGone(view, detail))
        assertEquals(listOf(LiveStop.CRASHED), stops)
    }

    @Test
    fun anUnresponsiveRendererStopsThePageWithoutTerminatingIt() {
        LiveRenderProcessClient(listener).onRenderProcessUnresponsive(view(), null)
        assertEquals(listOf(LiveStop.WATCHDOG), stops)
    }

    @Test
    fun refusesWindowsPermissionsLocationFilesAndDialogs() {
        val view = view()
        val chrome = shadowOf(view).webChromeClient as LiveChromeClient
        assertFalse(chrome.onCreateWindow(view, false, true, null))

        var denied = false
        chrome.onPermissionRequest(object : PermissionRequest() {
            override fun getOrigin(): Uri = Uri.parse(this@LiveWebViewTest.origin)
            override fun getResources() = arrayOf(RESOURCE_VIDEO_CAPTURE, RESOURCE_AUDIO_CAPTURE)
            override fun grant(resources: Array<out String>?) = error("must not grant")
            override fun deny() {
                denied = true
            }
        })
        assertTrue(denied)

        var location: Boolean? = null
        chrome.onGeolocationPermissionsShowPrompt(origin) { _, allow, retain ->
            location = allow || retain
        }
        assertEquals(false, location)

        assertFalse(chrome.onShowFileChooser(view, null, null))

        fun cancelled(result: JsResult) = Shadow.extract<ShadowJsResult>(result).wasCancelled()
        val alert = Shadow.newInstanceOf(JsResult::class.java)
        val confirm = Shadow.newInstanceOf(JsResult::class.java)
        val prompt = Shadow.newInstanceOf(JsPromptResult::class.java)
        val unload = Shadow.newInstanceOf(JsResult::class.java)
        assertTrue(chrome.onJsAlert(view, origin, "a", alert))
        assertTrue(chrome.onJsConfirm(view, origin, "c", confirm))
        assertTrue(chrome.onJsPrompt(view, origin, "p", "", prompt))
        assertTrue(chrome.onJsBeforeUnload(view, origin, "u", unload))
        assertTrue(listOf(alert, confirm, prompt, unload).all(::cancelled))
    }

    @Test
    fun readsHeightErrorsAndBlockedUrlsFromTheConsoleAtMostOneHundredASecond() {
        val chrome = LiveChromeClient(listener) { 42_000L }
        fun line(text: String, level: ConsoleMessage.MessageLevel) = ConsoleMessage(text, origin, 1, level)
        assertTrue(chrome.onConsoleMessage(line("__sb_live_height__:240", ConsoleMessage.MessageLevel.LOG)))
        chrome.onConsoleMessage(line("__sb_live_blocked__:https://example.com/x", ConsoleMessage.MessageLevel.WARNING))
        chrome.onConsoleMessage(line("TypeError: x", ConsoleMessage.MessageLevel.ERROR))
        chrome.onConsoleMessage(line("just a log", ConsoleMessage.MessageLevel.LOG))
        assertEquals(
            listOf(
                HtmlLivePhone.Report.Height(240.0),
                HtmlLivePhone.Report.Blocked("https://example.com/x"),
                HtmlLivePhone.Report.Error("TypeError: x"),
            ),
            reports,
        )
        repeat(200) { chrome.onConsoleMessage(line("e$it", ConsoleMessage.MessageLevel.ERROR)) }
        assertEquals(HtmlLivePhone.MAX_REPORTS, chrome.reports.errors.size)
        // 4 lines above plus 96 of the flood fit in this second.
        assertEquals(3 + 96, reports.size)
    }
}
