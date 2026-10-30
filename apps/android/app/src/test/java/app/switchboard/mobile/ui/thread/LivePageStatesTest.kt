package app.switchboard.mobile.ui.thread

import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The live area falls back to the still image: Run on a low-RAM phone, Run again after a stop, nothing after two. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class LivePageStatesTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private val key = "k"

    @Before
    fun reset() = LivePages.reset()

    @After
    fun cleanUp() = LivePages.reset()

    private fun show(lowRam: Boolean) = compose.setContent {
        CompositionLocalProvider(LocalPhoneLiveLowRam provides lowRam) {
            LivePage(key, "<p>x</p>", "Page", still = null, placeholder = "No image yet.", onLongPress = {}, onZoomStill = {})
        }
    }

    @Test
    fun aLowRamPhoneWaitsForRun() {
        show(lowRam = true)
        compose.onNodeWithText("No image yet.").assertIsDisplayed()
        compose.onNodeWithText("Run").assertIsDisplayed()
    }

    @Test
    fun aStoppedPageOffersRunAgainOnce() {
        LivePages.stopped(key)
        show(lowRam = false)
        compose.onNodeWithText("This page stopped.").assertIsDisplayed()
        compose.onNodeWithText("Run again").assertIsDisplayed()
    }

    @Test
    fun aPageThatStoppedTwiceNeverRunsAgain() {
        LivePages.stopped(key)
        LivePages.stopped(key)
        show(lowRam = false)
        compose.onNodeWithText("This page stopped.").assertIsDisplayed()
        compose.onNodeWithText("Run again").assertDoesNotExist()
        compose.onNodeWithText("Run").assertDoesNotExist()
    }
}
