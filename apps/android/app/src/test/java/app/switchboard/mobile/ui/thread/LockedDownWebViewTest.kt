package app.switchboard.mobile.ui.thread

import android.view.View
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.net.Uri
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.assertIsDisplayed
import androidx.test.core.app.ApplicationProvider
import app.switchboard.mobile.domain.thread.VisualKind
import app.switchboard.mobile.ui.theme.SwitchboardTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class LockedDownWebViewTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private val crashed = object : RenderProcessGoneDetail() {
        override fun didCrash() = true
        override fun rendererPriorityAtExit() = 0
    }

    private fun request(url: String) = object : WebResourceRequest {
        override fun getUrl(): Uri = Uri.parse(url)
        override fun isForMainFrame() = true
        override fun isRedirect() = false
        override fun hasGesture() = false
        override fun getMethod() = "GET"
        override fun getRequestHeaders() = emptyMap<String, String>()
    }

    @Test
    fun settingsAreLockedDown() {
        val view = lockedDownWebView(ApplicationProvider.getApplicationContext(), LockedDownWebViewClient {})
        with(view.settings) {
            assertTrue(javaScriptEnabled)
            assertFalse(allowFileAccess)
            assertFalse(allowContentAccess)
            assertTrue(blockNetworkLoads)
            assertFalse(domStorageEnabled)
            assertFalse(javaScriptCanOpenWindowsAutomatically)
            assertFalse(supportMultipleWindows())
        }
    }

    @Test
    fun refusesEveryNavigation() {
        val client = LockedDownWebViewClient {}
        val view = lockedDownWebView(ApplicationProvider.getApplicationContext(), client)
        for (url in listOf("https://example.com", "intent://x#Intent;end", "market://details?id=x", "file:///etc/hosts", "content://settings/system")) {
            assertTrue(url, client.shouldOverrideUrlLoading(view, request(url)))
        }
    }

    @Test
    fun handlesALostRenderer() {
        var gone = 0
        val client = LockedDownWebViewClient { gone++ }
        val view = lockedDownWebView(ApplicationProvider.getApplicationContext(), client)
        assertTrue(client.onRenderProcessGone(view, crashed))
        assertEquals(1, gone)
    }

    @Test
    fun cardShowsAnErrorWhenTheRendererIsLost() {
        compose.setContent { SwitchboardTheme { ChatVisualCard(VisualKind.MERMAID, "flowchart LR\n A --> B") } }
        // The host page loads off the main thread before the WebView exists.
        compose.waitUntil(5_000) { findWebView(compose.activity.window.decorView) != null }
        val view = findWebView(compose.activity.window.decorView)!!
        compose.runOnUiThread { assertTrue(view.webViewClient.onRenderProcessGone(view, crashed)) }
        compose.onNodeWithText("This diagram could not be drawn: The drawing process stopped.").assertIsDisplayed()
        assertEquals(null, findWebView(compose.activity.window.decorView))
    }

    private fun findWebView(view: View): WebView? = when (view) {
        is WebView -> view
        is ViewGroup -> (0 until view.childCount).firstNotNullOfOrNull { findWebView(view.getChildAt(it)) }
        else -> null
    }
}
