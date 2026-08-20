package app.switchboard.mobile.ui.search

import app.switchboard.mobile.domain.remote.MessageSearchResult
import app.switchboard.mobile.protocol.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MessageSearchPresentationTest {
    @Test
    fun `projection removes FTS markers normalizes whitespace and preserves routing`() {
        val row = MessageSearchPresenter.row(
            MessageSearchResult(
                messageId = "message",
                conversationId = "thread",
                role = "user",
                content = "full",
                snippet = "...A  **native**\n\n result...",
                conversationTitle = "Native app",
                projectPath = "/Users/tejas/repo",
                agentType = "codex",
                worktreePath = "/worktree",
                worktreeBranch = "sb/native",
                raw = JsonObject(linkedMapOf()),
            ),
        )

        assertEquals("A native result", row.snippet)
        assertEquals("repo · You", row.metadata)
        assertEquals("thread", row.result.conversationId)
        assertEquals("/worktree", row.result.worktreePath)
    }

    @Test
    fun `projection caps pathological snippets`() {
        val snippet = MessageSearchPresenter.cleanSnippet("x".repeat(400))
        assertTrue(snippet.length <= 241)
        assertTrue(snippet.endsWith("…"))
    }
}
