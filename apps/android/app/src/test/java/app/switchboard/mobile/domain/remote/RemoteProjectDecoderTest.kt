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

    @Test
    fun `conversation row carries the stored status line`() {
        fun row(vararg extra: Pair<String, JsonValue>) = RemoteDecoders.conversations(
            JsonArray(
                listOf(
                    obj(
                        "id" to JsonString("thread-1"),
                        "project_path" to JsonString("/repo"),
                        "agent_type" to JsonString("claude-code"),
                        "title" to JsonString("Task"),
                        "created_at" to JsonNumber("1"),
                        "updated_at" to JsonNumber("2"),
                        *extra,
                    ),
                ),
            ),
        ).single()

        assertEquals("Tests pass, PR open", row("status_line" to JsonString("Tests pass, PR open")).statusLine)
        assertNull(row("status_line" to JsonNull).statusLine)
        assertNull(row().statusLine)
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
