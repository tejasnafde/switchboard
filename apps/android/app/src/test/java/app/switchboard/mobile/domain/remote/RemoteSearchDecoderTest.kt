package app.switchboard.mobile.domain.remote

import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class RemoteSearchDecoderTest {
    @Test
    fun `search result decoding preserves canonical route metadata`() {
        val result = RemoteDecoders.messageSearch(
            JsonArray(
                listOf(
                    resultJson(
                        "worktreePath" to JsonString("/repo/.switchboard/worktrees/fix"),
                        "worktreeBranch" to JsonString("sb/fix"),
                    ),
                ),
            ),
        ).single()

        assertEquals("message-1", result.messageId)
        assertEquals("thread-1", result.conversationId)
        assertEquals("Native app", result.conversationTitle)
        assertEquals("/repo", result.projectPath)
        assertEquals("codex", result.agentType)
        assertEquals("/repo/.switchboard/worktrees/fix", result.worktreePath)
        assertEquals("sb/fix", result.worktreeBranch)
    }

    @Test
    fun `search decoding accepts nullable worktree fields but rejects missing routing fields`() {
        val nullable = RemoteDecoders.messageSearch(
            JsonArray(
                listOf(
                    resultJson(
                        "worktreePath" to JsonNull,
                        "worktreeBranch" to JsonNull,
                    ),
                ),
            ),
        ).single()

        assertNull(nullable.worktreePath)
        assertNull(nullable.worktreeBranch)

        val missingProject = resultJson().let { raw ->
            JsonObject(LinkedHashMap(raw.values).apply { remove("projectPath") })
        }
        assertThrows(IllegalStateException::class.java) {
            RemoteDecoders.messageSearch(JsonArray(listOf(missingProject)))
        }
    }

    private fun resultJson(vararg extra: Pair<String, app.switchboard.mobile.protocol.JsonValue>) =
        JsonObject(
            linkedMapOf(
                "messageId" to JsonString("message-1"),
                "conversationId" to JsonString("thread-1"),
                "role" to JsonString("assistant"),
                "content" to JsonString("full body"),
                "snippet" to JsonString("...**native** body..."),
                "conversationTitle" to JsonString("Native app"),
                "projectPath" to JsonString("/repo"),
                "agentType" to JsonString("codex"),
                "worktreePath" to JsonNull,
                "worktreeBranch" to JsonNull,
                *extra,
            ),
        )
}
