package app.switchboard.mobile.ui.thread

import android.graphics.Bitmap
import android.util.Base64
import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.performTouchInput
import app.switchboard.mobile.data.remote.HtmlLiveImages
import app.switchboard.mobile.data.remote.HtmlLiveRemote
import app.switchboard.mobile.domain.remote.RemoteOutcome
import app.switchboard.mobile.domain.remote.RemoteRequestKey
import app.switchboard.mobile.domain.remote.RemoteResponse
import app.switchboard.mobile.domain.thread.HtmlLivePages
import app.switchboard.mobile.domain.thread.HtmlLiveState
import app.switchboard.mobile.domain.thread.MessageSegment
import app.switchboard.mobile.domain.thread.VisualKind
import app.switchboard.mobile.platform.protocol.RequestSubmission
import app.switchboard.mobile.platform.protocol.TransportScope
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.ui.theme.SwitchboardTheme
import java.io.ByteArrayOutputStream
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34])
class ShareVisualUiTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private class StillRemote(private val dataUrl: String) : HtmlLiveRemote {
        private val key = RemoteRequestKey("c", 1, "op")

        override fun htmlLiveLoad(key: String, callback: (RemoteResponse<HtmlLiveState>) -> Unit): RequestSubmission {
            callback(RemoteResponse(this.key, RemoteOutcome.Success(HtmlLiveState(dataUrl, null))))
            return RequestSubmission.Accepted(1, TransportScope("d", "c", 1))
        }

        override fun htmlLiveOpenOnDesktop(request: JsonObject, callback: (RemoteResponse<String>) -> Unit): RequestSubmission =
            RequestSubmission.Accepted(1, TransportScope("d", "c", 1))
    }

    private fun pngDataUrl(): String {
        val bitmap = Bitmap.createBitmap(4, 4, Bitmap.Config.ARGB_8888)
        val bytes = ByteArrayOutputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it); it.toByteArray() }
        return "data:image/png;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
    }

    @Test
    fun aDrawnVisualShowsShare() {
        val source = "graph TD\n  share-test-a --> share-test-b"
        seedDrawnVisual(VisualKind.MERMAID, source, 120)
        compose.setContent { SwitchboardTheme { ChatVisualCard(VisualKind.MERMAID, source) } }
        compose.waitUntil(5_000) { compose.onAllNodes(hasText("Share")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Share").assertIsDisplayed()
    }

    @Test
    fun aShownStillImageOffersShareImageInTheSheet() {
        val images = HtmlLiveImages(setOf(HtmlLivePages.CAPABILITY), "t1", StillRemote(pngDataUrl()))
        compose.setContent {
            SwitchboardTheme {
                CompositionLocalProvider(LocalHtmlLive provides images) {
                    HtmlLiveCard(MessageSegment.HtmlLive("<b>share test</b>", "Page", closed = true))
                }
            }
        }
        compose.waitUntil(5_000) {
            compose.onAllNodes(hasContentDescription("Still image of Page")).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithContentDescription("Live page: Page").performTouchInput { longClick() }
        compose.waitForIdle()
        compose.onNodeWithText("Share image").assertIsDisplayed()
        compose.onNodeWithText("PNG, as captured").assertIsDisplayed()
    }
}
