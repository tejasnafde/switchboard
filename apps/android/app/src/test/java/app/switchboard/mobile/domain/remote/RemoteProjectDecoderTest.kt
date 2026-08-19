package app.switchboard.mobile.domain.remote

import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RemoteProjectDecoderTest {
    @Test
    fun `project session retains direct route metadata`() {
        val session = RemoteDecoders.projects(
            JsonArray(
                listOf(
                    project(
                        "agentType" to JsonString("codex"),
                        "worktreePath" to JsonString("/repo/.switchboard/worktrees/task"),
                        "worktreeBranch" to JsonString("sb/task"),
                    ),
                ),
            ),
        ).single().sessions.single()

        assertEquals("codex", session.agentType)
        assertEquals("/repo/.switchboard/worktrees/task", session.worktreePath)
        assertEquals("sb/task", session.worktreeBranch)
    }

    @Test
    fun `project session accepts absent direct route metadata`() {
        val session = RemoteDecoders.projects(
            JsonArray(listOf(project())),
        ).single().sessions.single()

        assertNull(session.agentType)
        assertNull(session.worktreePath)
        assertNull(session.worktreeBranch)
    }

    private fun project(vararg sessionFields: Pair<String, JsonValue>) = obj(
        "path" to JsonString("/repo"),
        "name" to JsonString("repo"),
        "sessions" to JsonArray(
            listOf(
                obj(
                    "id" to JsonString("thread-1"),
                    "source" to JsonString("codex"),
                    "title" to JsonString("Task"),
                    "startedAt" to JsonNumber("42"),
                    "messageCount" to JsonNumber("3"),
                    "filePath" to JsonString("/repo/thread-1.jsonl"),
                    *sessionFields,
                ),
            ),
        ),
        "workspaceId" to JsonNull,
    )

    private fun obj(vararg fields: Pair<String, JsonValue>) =
        JsonObject(linkedMapOf(*fields))
}
