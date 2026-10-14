package app.switchboard.mobile.ui.demo

import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Handler
import android.os.Looper
import android.view.View
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.SemanticsNodeInteractionsProvider
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import app.switchboard.mobile.data.remote.PhoneDemoTestFixture
import app.switchboard.mobile.platform.protocol.Cancelable
import app.switchboard.mobile.platform.protocol.TransportScheduler
import app.switchboard.mobile.ui.SwitchboardApp
import app.switchboard.mobile.ui.connections.ConnectionsLoadState
import app.switchboard.mobile.ui.navigation.PhoneDemoController
import app.switchboard.mobile.ui.reviews.ReviewsTestTags
import app.switchboard.mobile.ui.settings.SettingsTestTags
import app.switchboard.mobile.ui.theme.SwitchboardTheme
import java.io.File
import java.time.Duration
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Drives the real navigation through the demo: Try the demo, the strip on
 * every screen, an approval, Reviews, and both ways out. With native
 * graphics it also writes the screens to /tmp/sb-demomode for a person to
 * look at (outside the repo); a missing folder is created, never required.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class PhoneDemoUiTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    /** Demo timers on the main looper, which the test advances by hand. */
    private class MainLooperScheduler : TransportScheduler {
        private val handler = Handler(Looper.getMainLooper())

        override fun schedule(delayMs: Long, block: () -> Unit): Cancelable {
            val runnable = Runnable(block)
            handler.postDelayed(runnable, delayMs)
            return Cancelable { handler.removeCallbacks(runnable) }
        }
    }

    private val controller = PhoneDemoController(
        readFixture = PhoneDemoTestFixture::json,
        newScheduler = { MainLooperScheduler() to {} },
        log = { _, _ -> },
    )

    private fun launch() {
        compose.setContent {
            SwitchboardTheme {
                SwitchboardApp(
                    connectionsState = ConnectionsLoadState.Ready(emptyList()),
                    buildStamp = "v0.5.18 · native",
                    phoneDemo = controller,
                )
            }
        }
        compose.waitForIdle()
    }

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

    private fun shot(name: String) {
        val out = File(SHOT_DIR)
        if (!out.isDirectory && !out.mkdirs()) return
        val view: View = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        File(out, "android-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun SemanticsNodeInteractionsProvider.stripShown() =
        onNodeWithTag(PhoneDemoTestTags.STRIP).assertIsDisplayed()

    @Test
    fun tryTheDemoOpensTheSampleProjectAndLeaveDemoEndsIt() {
        launch()
        compose.onNodeWithTag(PhoneDemoTestTags.TRY).assertIsDisplayed()
        compose.onNodeWithText(PhoneDemoCopy.TRY_DETAIL).assertIsDisplayed()
        shot("home-empty")

        compose.onNodeWithText("Manage").performClick()
        compose.waitForIdle()
        compose.onNodeWithText("Enter address manually").assertIsDisplayed()
        compose.onNodeWithTag(PhoneDemoTestTags.TRY).assertIsDisplayed()
        shot("connections-empty")

        compose.onNodeWithTag(PhoneDemoTestTags.TRY).performClick()
        waitForText("Run the test suite after the fix")
        advance(1_000)
        compose.stripShown()
        compose.onNodeWithText("acme-console").assertIsDisplayed()
        compose.onNodeWithText("Add pagination to the orders table").assertIsDisplayed()
        compose.onNodeWithText("Retry uploads when a signed URL expires").assertIsDisplayed()
        assertNotNull(controller.active.value)
        shot("demo-project")

        compose.onNodeWithText("Run the test suite after the fix").performClick()
        waitForText("npm test -- src/billing")
        waitForText("Approve")
        compose.stripShown()
        shot("approval-thread")
        compose.onAllNodesWithText("Approve").onFirst().performClick()
        advance(5_000)
        waitForText("All 12 billing tests pass")
        back()

        back()
        compose.onNodeWithTag(ReviewsTestTags.TAB_REVIEWS).performClick()
        waitForText("Fix rounding in invoice totals")
        compose.stripShown()
        shot("demo-reviews")
        compose.onNodeWithText("Retry uploads when a signed URL expires").performClick()
        waitForText("Work on PR")
        compose.stripShown()
        compose.onNodeWithContentDescription("Open in browser").assertDoesNotExist()
        shot("demo-pr-detail")

        compose.onNodeWithTag(PhoneDemoTestTags.LEAVE).performClick()
        compose.onNodeWithText(PhoneDemoCopy.LEAVE_TITLE).assertIsDisplayed()
        compose.onNodeWithText(PhoneDemoCopy.LEAVE_BODY).assertIsDisplayed()
        compose.onNodeWithText(PhoneDemoCopy.STAY).assertIsDisplayed()
        compose.onNodeWithTag(PhoneDemoTestTags.CONFIRM_LEAVE).performClick()
        compose.waitForIdle()
        assertNull(controller.active.value)
        compose.onNodeWithTag(PhoneDemoTestTags.STRIP).assertDoesNotExist()
        compose.onNodeWithTag(PhoneDemoTestTags.TRY).assertIsDisplayed()
    }

    @Test
    fun settingsAlsoLeavesTheDemo() {
        launch()
        compose.onNodeWithTag(PhoneDemoTestTags.TRY).performClick()
        waitForText("Run the test suite after the fix")
        back()
        back()
        compose.onNodeWithContentDescription("Settings").performClick()
        compose.waitForIdle()
        compose.stripShown()
        compose.onNodeWithTag(SettingsTestTags.LEAVE_DEMO).performClick()
        compose.onNodeWithTag(PhoneDemoTestTags.CONFIRM_LEAVE).performClick()
        compose.waitForIdle()
        assertNull(controller.active.value)
        compose.onNodeWithTag(PhoneDemoTestTags.TRY).assertIsDisplayed()
        compose.onAllNodes(hasText(PhoneDemoCopy.STRIP_DETAIL, substring = true)).assertCountEquals(0)
    }

    private companion object {
        const val SHOT_DIR = "/tmp/sb-demomode"
    }
}
