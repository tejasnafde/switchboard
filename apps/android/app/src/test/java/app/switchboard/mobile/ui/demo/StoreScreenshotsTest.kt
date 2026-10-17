package app.switchboard.mobile.ui.demo

import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Handler
import android.os.Looper
import android.view.View
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import app.switchboard.mobile.data.remote.PhoneDemoTestFixture
import app.switchboard.mobile.platform.protocol.Cancelable
import app.switchboard.mobile.platform.protocol.TransportScheduler
import app.switchboard.mobile.ui.SwitchboardApp
import app.switchboard.mobile.ui.connections.ConnectionsLoadState
import app.switchboard.mobile.ui.navigation.PhoneDemoController
import app.switchboard.mobile.ui.reviews.ReviewsTestTags
import app.switchboard.mobile.ui.theme.SwitchboardTheme
import app.switchboard.mobile.ui.thread.ThreadTestTags
import java.io.File
import java.time.Duration
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Renders the Play store screenshots (docs/store/play) from the demo mode at
 * 1080x1920. Skipped unless SB_STORE_SHOTS_DIR names an output folder:
 *
 *   SB_STORE_SHOTS_DIR=$PWD/../../docs/store/play ./gradlew :app:testDebugUnitTest \
 *     --tests '*StoreScreenshotsTest' --max-workers=2
 *
 * then docs/store/play/source/render.py, which flattens them to 24-bit PNG.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w360dp-h640dp-xxhdpi")
class StoreScreenshotsTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private class MainLooperScheduler : TransportScheduler {
        private val handler = Handler(Looper.getMainLooper())

        override fun schedule(delayMs: Long, block: () -> Unit): Cancelable {
            val runnable = Runnable(block)
            handler.postDelayed(runnable, delayMs)
            return Cancelable { handler.removeCallbacks(runnable) }
        }
    }

    private val outDir = System.getenv("SB_STORE_SHOTS_DIR")?.takeIf(String::isNotBlank)

    private val controller = PhoneDemoController(
        readFixture = PhoneDemoTestFixture::json,
        newScheduler = { MainLooperScheduler() to {} },
        log = { _, _ -> },
    )

    private fun advance(ms: Long) {
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(ms))
        compose.waitForIdle()
    }

    private fun waitForText(text: String) {
        repeat(200) {
            if (compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty()) return
            advance(50)
        }
        throw AssertionError("\"$text\" never appeared")
    }

    private fun back() {
        compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }
        compose.waitForIdle()
    }

    private fun scrollFeedTo(text: String) {
        compose.onNodeWithTag(ThreadTestTags.FEED).performScrollToNode(hasText(text))
        compose.waitForIdle()
    }

    private fun shot(name: String) {
        val view: View = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        File(outDir, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test
    fun rendersTheStoreScreenshots() {
        assumeTrue("set SB_STORE_SHOTS_DIR to render", outDir != null)
        File(outDir!!).mkdirs()
        compose.setContent {
            SwitchboardTheme {
                SwitchboardApp(
                    connectionsState = ConnectionsLoadState.Ready(emptyList()),
                    buildStamp = "",
                    phoneDemo = controller,
                )
            }
        }
        compose.waitForIdle()

        compose.onNodeWithText("Manage").performClick()
        compose.waitForIdle()
        shot("01-connections")

        compose.onNodeWithTag(PhoneDemoTestTags.TRY).performClick()
        waitForText("Run the test suite after the fix")
        advance(1_000)
        shot("02-chats")

        compose.onNodeWithText("Retry uploads when a signed URL expires").performClick()
        advance(1_000)
        scrollFeedTo("Changed 3 files")
        compose.onNodeWithText("Changed 3 files").performClick()
        compose.waitForIdle()
        scrollFeedTo("src/upload/putFile.ts")
        compose.onNodeWithText("src/upload/putFile.ts").performClick()
        compose.waitForIdle()
        scrollFeedTo("src/upload/putFile.ts")
        advance(3_000)
        shot("05-diff")
        back()

        compose.onNodeWithText("Add pagination to the orders table").performClick()
        waitForText("Wiring the table to it next")
        advance(1_500)
        shot("03-running-chat")
        back()

        compose.onNodeWithText("Run the test suite after the fix").performClick()
        waitForText("npm test -- src/billing")
        waitForText("Approve")
        shot("04-approval")
        back()
        back()

        compose.onNodeWithTag(ReviewsTestTags.TAB_REVIEWS).performClick()
        waitForText("Fix rounding in invoice totals")
        shot("06-reviews")
    }
}
