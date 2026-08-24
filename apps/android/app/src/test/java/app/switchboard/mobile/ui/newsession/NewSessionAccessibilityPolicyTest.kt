package app.switchboard.mobile.ui.newsession

import org.junit.Assert.assertEquals
import org.junit.Test

class NewSessionAccessibilityPolicyTest {
    @Test
    fun choiceAndLaunchStatesDoNotDependOnGlyphsOrSpinnerShape() {
        assertEquals("Selected", NewSessionAccessibilityPolicy.choiceState(selected = true))
        assertEquals("Not selected", NewSessionAccessibilityPolicy.choiceState(selected = false))
        assertEquals("Starting session", NewSessionAccessibilityPolicy.launchState(submitting = true))
        assertEquals("Start session", NewSessionAccessibilityPolicy.launchState(submitting = false))
        assertEquals(
            "Creating worktree",
            NewSessionAccessibilityPolicy.launchState(submitting = true, worktree = true),
        )
        assertEquals(
            "Create worktree",
            NewSessionAccessibilityPolicy.launchState(submitting = false, worktree = true),
        )
    }
}
