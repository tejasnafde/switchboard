package app.switchboard.mobile.ui.browse

import app.switchboard.mobile.domain.remote.Conversation
import app.switchboard.mobile.protocol.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Test

/** Mirrors tests/unit/sidebar-recent-groups.test.ts: which group a chat lands in, and the dot. */
class BrowseConversationGroupsTest {
    @Test
    fun anOpenCardOrAnErrorNeedsYouAndARunningChatIsWorking() {
        assertEquals(BrowseConversationGroupKey.NeedsYou, BrowseConversationGroups.key(row(attention = BrowseThreadAttention.Approval)))
        assertEquals(BrowseConversationGroupKey.NeedsYou, BrowseConversationGroups.key(row(attention = BrowseThreadAttention.Input)))
        assertEquals(BrowseConversationGroupKey.NeedsYou, BrowseConversationGroups.key(row(attention = BrowseThreadAttention.Plan)))
        assertEquals(BrowseConversationGroupKey.NeedsYou, BrowseConversationGroups.key(row(status = "error")))
        // An open card outranks the running status.
        assertEquals(
            BrowseConversationGroupKey.NeedsYou,
            BrowseConversationGroups.key(row(status = "running", attention = BrowseThreadAttention.Approval)),
        )
        assertEquals(BrowseConversationGroupKey.Working, BrowseConversationGroups.key(row(status = "running")))
        assertEquals(BrowseConversationGroupKey.Done, BrowseConversationGroups.key(row(status = "idle", unread = 2)))
        assertEquals(BrowseConversationGroupKey.Done, BrowseConversationGroups.key(row(attention = BrowseThreadAttention.None)))
    }

    @Test
    fun groupsComeInOrderKeepRowOrderAndDropEmptyOnes() {
        val groups = BrowseConversationGroups.group(
            listOf(
                row("done-1"),
                row("work", status = "running"),
                row("ask", attention = BrowseThreadAttention.Input),
                row("done-2"),
            ),
        )
        assertEquals(listOf("Needs you", "Working", "Done recently"), groups.map { it.key.label })
        assertEquals(listOf("done-1", "done-2"), groups.last().rows.map { it.id })

        assertEquals(
            listOf(BrowseConversationGroupKey.NeedsYou),
            BrowseConversationGroups.group(listOf(row("ask", status = "failed"))).map { it.key },
        )
    }

    @Test
    fun aListWithNothingActiveStaysOnePlainList() {
        assertEquals(emptyList<BrowseConversationGroup>(), BrowseConversationGroups.group(listOf(row("a"), row("b"))))
    }

    @Test
    fun theDotCarriesTheColour() {
        assertEquals(BrowseActivityTone.ATTENTION, BrowseVisualPolicy.activityTone("running", 0, BrowseThreadAttention.Plan))
        assertEquals(BrowseActivityTone.ERROR, BrowseVisualPolicy.activityTone("error", 0, BrowseThreadAttention.Approval))
        assertEquals(BrowseActivityTone.ACTIVE, BrowseVisualPolicy.activityTone("running", 0, BrowseThreadAttention.None))
        assertEquals(BrowseActivityTone.UNREAD, BrowseVisualPolicy.activityTone("idle", 1))
    }

    @Test
    fun theStatusLineSaysWhatTheChatIsWaitingOn() {
        assertEquals("Claude · Waiting on your approval", BrowseRowPolicy.conversationSupportingLabel(row(attention = BrowseThreadAttention.Approval)))
        assertEquals("Claude · Waiting on your answer", BrowseRowPolicy.conversationSupportingLabel(row(attention = BrowseThreadAttention.Input)))
        assertEquals("Claude · Plan ready for your review", BrowseRowPolicy.conversationSupportingLabel(row(attention = BrowseThreadAttention.Plan)))
    }

    private fun row(
        id: String = "thread",
        status: String? = null,
        unread: Int = 0,
        attention: BrowseThreadAttention = BrowseThreadAttention.Unknown,
    ) = BrowseConversationRow(
        conversation = Conversation(
            id = id,
            projectPath = "/work",
            agentType = "claude",
            sessionId = id,
            title = id,
            createdAt = 0,
            updatedAt = 0,
            worktreePath = null,
            worktreeBranch = null,
            raw = JsonObject(linkedMapOf()),
        ),
        id = id,
        title = id,
        agentType = "claude",
        updatedAt = 0,
        availableOffline = false,
        unread = unread,
        status = status,
        attention = attention,
    )
}
