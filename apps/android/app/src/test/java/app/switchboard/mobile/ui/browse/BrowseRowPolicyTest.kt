package app.switchboard.mobile.ui.browse

import app.switchboard.mobile.domain.remote.Conversation
import app.switchboard.mobile.domain.remote.Project
import app.switchboard.mobile.protocol.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BrowseRowPolicyTest {
    @Test
    fun projectMonogramsStayCompactAndReadable() {
        assertEquals("SW", BrowseVisualPolicy.projectMonogram("switchboard"))
        assertEquals("TS", BrowseVisualPolicy.projectMonogram("tejas-skills"))
        assertEquals("HF", BrowseVisualPolicy.projectMonogram("Hyper Frames"))
        assertEquals("•", BrowseVisualPolicy.projectMonogram("  "))
    }

    @Test
    fun activityToneUsesOneStableVisualPriority() {
        assertEquals(BrowseActivityTone.ERROR, BrowseVisualPolicy.activityTone("failed", unread = 2))
        assertEquals(BrowseActivityTone.ACTIVE, BrowseVisualPolicy.activityTone("working", unread = 0))
        assertEquals(BrowseActivityTone.ATTENTION, BrowseVisualPolicy.activityTone("queued", unread = 0))
        assertEquals(BrowseActivityTone.UNREAD, BrowseVisualPolicy.activityTone(null, unread = 3))
        assertEquals(BrowseActivityTone.MUTED, BrowseVisualPolicy.activityTone("idle", unread = 0))
    }

    @Test
    fun projectTrailingLabelPrioritizesErrorsThenUnreadThenActivityThenCount() {
        assertEquals("error", BrowseRowPolicy.projectTrailingLabel(project(unread = 3, status = "error")))
        assertEquals("3 unread", BrowseRowPolicy.projectTrailingLabel(project(unread = 3, status = "running")))
        assertEquals("running", BrowseRowPolicy.projectTrailingLabel(project(status = "running")))
        assertEquals("4 chats", BrowseRowPolicy.projectTrailingLabel(project()))
        assertEquals("1 chat", BrowseRowPolicy.projectTrailingLabel(project(sessionCount = 1)))
    }

    @Test
    fun conversationSupportingLabelLeavesTheAgentToItsMarkAndShowsOneActivityCue() {
        assertEquals("failed", BrowseRowPolicy.conversationSupportingLabel(conversation(unread = 2, status = "failed")))
        assertEquals("2 unread", BrowseRowPolicy.conversationSupportingLabel(conversation(unread = 2)))
        assertEquals(
            "running",
            BrowseRowPolicy.conversationSupportingLabel(conversation(agentType = "opencode", status = "running")),
        )
        assertEquals("saved", BrowseRowPolicy.conversationSupportingLabel(conversation(agentType = "codex")))
    }

    @Test
    fun conversationSupportingLabelNamesAnAgentThatHasNoMark() {
        assertEquals(
            "Cursor · saved",
            BrowseRowPolicy.conversationSupportingLabel(conversation(originSource = "cursor")),
        )
        assertEquals(
            "Local · saved",
            BrowseRowPolicy.conversationSupportingLabel(conversation(agentType = "acp-command")),
        )
        assertEquals(
            "some-future-agent · saved",
            BrowseRowPolicy.conversationSupportingLabel(conversation(agentType = "some-future-agent")),
        )
    }

    @Test
    fun aCursorImportKeepsItsNameAndDrawsNoMark() {
        // A Cursor import is stored as claude-code: its mark would name the wrong product.
        val cursor = conversation(originSource = "cursor")
        assertNull(BrowseRowPolicy.conversationMarkAgent(cursor))
        assertEquals("claude", BrowseRowPolicy.conversationMarkAgent(conversation()))
    }

    @Test
    fun conversationSupportingLabelIsEmptyWhenTheMarkSaysItAll() {
        assertEquals("", BrowseRowPolicy.conversationSupportingLabel(conversation(availableOffline = false)))
    }

    @Test
    fun conversationSupportingLabelShowsTheTurnPreviewAfterAFailure() {
        assertEquals(
            "Reading files",
            BrowseRowPolicy.conversationSupportingLabel(conversation(unread = 2, status = "running", preview = "Reading files")),
        )
        assertEquals(
            "failed",
            BrowseRowPolicy.conversationSupportingLabel(conversation(status = "failed", preview = "Reading files")),
        )
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
        originSource: String? = null,
        unread: Int = 0,
        status: String? = null,
        preview: String? = null,
        availableOffline: Boolean = true,
    ) = BrowseConversationRow(
        conversation = Conversation(
            id = "thread-1",
            projectPath = "/work/switchboard",
            agentType = agentType,
            originSource = originSource,
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
        originSource = originSource,
        updatedAt = 0,
        availableOffline = availableOffline,
        unread = unread,
        status = status,
        preview = preview,
    )
}
