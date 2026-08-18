package app.switchboard.mobile.ui.browse

import org.junit.Assert.assertEquals
import org.junit.Test

class BrowseAccessibilityPolicyTest {
    @Test
    fun projectAndConversationDescriptionsIncludeUsefulStateWithoutVisualSymbols() {
        assertEquals(
            "Switchboard, 3 sessions",
            BrowseAccessibilityPolicy.projectDescription("Switchboard", 3),
        )
        assertEquals(
            "2 unread, running",
            BrowseAccessibilityPolicy.projectState(unread = 2, status = "running"),
        )
        assertEquals(
            "Fix reconnect, Codex",
            BrowseAccessibilityPolicy.conversationDescription("Fix reconnect", "codex"),
        )
        assertEquals(
            "saved offline, 1 unread, failed",
            BrowseAccessibilityPolicy.conversationState(
                availableOffline = true,
                unread = 1,
                status = "failed",
            ),
        )
    }

    @Test
    fun workspaceStateIsDeterministic() {
        assertEquals("Collapsed", BrowseAccessibilityPolicy.workspaceState(collapsed = true))
        assertEquals("Expanded", BrowseAccessibilityPolicy.workspaceState(collapsed = false))
    }
}
