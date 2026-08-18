package app.switchboard.mobile.platform.notification

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppVisibilityTrackerTest {
    @Test
    fun `only the final stopped activity backgrounds the process`() {
        val tracker = AppVisibilityTracker()

        tracker.activityStarted()
        tracker.activityStarted()
        tracker.activityStopped(changingConfigurations = false)

        assertTrue(tracker.isForeground)
        tracker.activityStopped(changingConfigurations = false)
        assertFalse(tracker.isForeground)
    }

    @Test
    fun `configuration replacement does not create a false background window`() {
        val tracker = AppVisibilityTracker()
        tracker.activityStarted()

        tracker.activityStopped(changingConfigurations = true)
        assertTrue(tracker.isForeground)

        tracker.activityStarted()
        assertTrue(tracker.isForeground)
    }

    @Test
    fun `pause alone does not count as background`() {
        val tracker = AppVisibilityTracker()
        tracker.activityStarted()

        assertTrue(tracker.isForeground)
    }

    @Test
    fun `callbacks fire once per real process transition and skip configuration replacement`() {
        val transitions = mutableListOf<AppVisibilityTransition>()
        val tracker = AppVisibilityTracker(transitions::add)

        tracker.activityStarted()
        tracker.activityStarted()
        tracker.activityStopped(changingConfigurations = false)
        tracker.activityStopped(changingConfigurations = true)
        tracker.activityStarted()
        tracker.activityStopped(changingConfigurations = false)

        assertEquals(
            listOf(AppVisibilityTransition.Foreground, AppVisibilityTransition.Background),
            transitions,
        )
    }
}
