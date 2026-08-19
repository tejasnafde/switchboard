package app.switchboard.mobile.ui.browse

import app.switchboard.mobile.domain.remote.Conversation
import app.switchboard.mobile.domain.remote.Project
import app.switchboard.mobile.protocol.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Test

class BrowseRowPolicyTest {
    @Test
    fun projectTrailingLabelPrioritizesErrorsThenUnreadThenActivityThenCount() {
        assertEquals("error", BrowseRowPolicy.projectTrailingLabel(project(unread = 3, status = "error")))
        assertEquals("3 unread", BrowseRowPolicy.projectTrailingLabel(project(unread = 3, status = "running")))
        assertEquals("running", BrowseRowPolicy.projectTrailingLabel(project(status = "running")))
        assertEquals("4 chats", BrowseRowPolicy.projectTrailingLabel(project()))
        assertEquals("1 chat", BrowseRowPolicy.projectTrailingLabel(project(sessionCount = 1)))
    }

    @Test
    fun conversationSupportingLabelUsesReadableAgentAndOnlyOneActivityCue() {
        assertEquals(
            "Claude · failed",
            BrowseRowPolicy.conversationSupportingLabel(conversation(unread = 2, status = "failed")),
        )
        assertEquals("Claude · 2 unread", BrowseRowPolicy.conversationSupportingLabel(conversation(unread = 2)))
        assertEquals(
            "OpenCode · running",
            BrowseRowPolicy.conversationSupportingLabel(conversation(agentType = "opencode", status = "running")),
        )
        assertEquals("Codex · saved", BrowseRowPolicy.conversationSupportingLabel(conversation(agentType = "codex")))
    }

    private fun project(
        sessionCount: Int = 4,
        unread: Int = 0,
        status: String? = null,
    ) = BrowseProjectRow(
        project = Project(
            path = "/work/switchboard",
            name = "Switchboard",
            sessions = emptyList(),
            workspaceId = null,
            raw = JsonObject(linkedMapOf()),
        ),
        path = "/work/switchboard",
        name = "Switchboard",
        sessionCount = sessionCount,
        unread = unread,
        status = status,
    )

    private fun conversation(
        agentType: String = "claude",
        unread: Int = 0,
        status: String? = null,
    ) = BrowseConversationRow(
        conversation = Conversation(
            id = "thread-1",
            projectPath = "/work/switchboard",
            agentType = agentType,
            sessionId = "thread-1",
            title = "Fix mobile UI",
            createdAt = 0,
            updatedAt = 0,
            worktreePath = null,
            worktreeBranch = null,
            raw = JsonObject(linkedMapOf()),
        ),
        id = "thread-1",
        title = "Fix mobile UI",
        agentType = agentType,
        updatedAt = 0,
        availableOffline = true,
        unread = unread,
        status = status,
    )
}
