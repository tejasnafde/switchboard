package app.switchboard.mobile.domain.thread

import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** `SystemMarkers.mergeBackRow` + `mergeBackPreviewNote`: ports of the parser
 *  and card helpers in src/shared/merge-back.ts. */
class MergeBackTest {
    @Test
    fun `a valid merge-back marker parses every field`() {
        val content = "[[sb:merge-back]] " + JsonCodecEncode(
            "id" to JsonString("mb_1"),
            "fork" to JsonString("agent_9"),
            "forkTitle" to JsonString("try sqlite paging"),
            "state" to JsonString("pending"),
            "turns" to app.switchboard.mobile.protocol.JsonNumber("2"),
            "omittedTurns" to app.switchboard.mobile.protocol.JsonNumber("0"),
            "files" to JsonArray(listOf(JsonString("src/main/agent/jsonl-cache.ts"))),
            "moreFiles" to app.switchboard.mobile.protocol.JsonNumber("0"),
            "location" to JsonString("worktree /repo/.switchboard/worktrees/fork-1"),
            "result" to JsonString("Tail parse cuts chat.open from 4.3 s to 0.6 s."),
            "text" to JsonString("From the fork \"try sqlite paging\": 2 turns since the fork point."),
        )

        val row = SystemMarkers.mergeBackRow(content)

        assertEquals(
            MergeBackRow(
                id = "mb_1",
                fork = "agent_9",
                forkTitle = "try sqlite paging",
                state = "pending",
                turns = 2,
                omittedTurns = 0,
                files = listOf("src/main/agent/jsonl-cache.ts"),
                moreFiles = 0,
                location = "worktree /repo/.switchboard/worktrees/fork-1",
                result = "Tail parse cuts chat.open from 4.3 s to 0.6 s.",
                text = "From the fork \"try sqlite paging\": 2 turns since the fork point.",
            ),
            row,
        )
    }

    @Test
    fun `an unrecognised state fails to parse`() {
        val content = "[[sb:merge-back]] " + JsonCodecEncode(
            "id" to JsonString("mb_1"),
            "fork" to JsonString("agent_9"),
            "forkTitle" to JsonString("try sqlite paging"),
            "state" to JsonString("sent"),
            "turns" to app.switchboard.mobile.protocol.JsonNumber("2"),
            "omittedTurns" to app.switchboard.mobile.protocol.JsonNumber("0"),
            "files" to JsonArray(emptyList()),
            "moreFiles" to app.switchboard.mobile.protocol.JsonNumber("0"),
            "text" to JsonString("text"),
        )

        assertNull(SystemMarkers.mergeBackRow(content))
    }

    @Test
    fun `a missing required field fails to parse`() {
        val content = "[[sb:merge-back]] " + JsonCodecEncode(
            "id" to JsonString("mb_1"),
            "fork" to JsonString("agent_9"),
            "forkTitle" to JsonString("try sqlite paging"),
            "state" to JsonString("pending"),
            "turns" to app.switchboard.mobile.protocol.JsonNumber("2"),
            "omittedTurns" to app.switchboard.mobile.protocol.JsonNumber("0"),
            "files" to JsonArray(emptyList()),
            "moreFiles" to app.switchboard.mobile.protocol.JsonNumber("0"),
            // "text" is missing.
        )

        assertNull(SystemMarkers.mergeBackRow(content))
    }

    @Test
    fun `title and details match the stored card`() {
        val row = MergeBackRow(
            id = "mb_1",
            fork = "agent_9",
            forkTitle = "try sqlite paging",
            state = "pending",
            turns = 2,
            omittedTurns = 1,
            files = listOf("a.ts"),
            moreFiles = 3,
            location = "worktree /repo",
            result = "Done.",
            text = "text",
        )

        assertEquals("From fork \"try sqlite paging\" (not sent yet)", SystemMarkers.title(row))
        assertEquals(
            listOf(
                "2 turns since the fork point or the last send (1 left out to fit)",
                "Changed: a.ts, and 3 more (in worktree /repo)",
                "Result: Done.",
            ),
            SystemMarkers.details(row),
        )

        val delivered = row.copy(state = "delivered")
        assertEquals("From fork \"try sqlite paging\" · Sent with your message", SystemMarkers.title(delivered))
    }

    @Test
    fun `preview note pluralizes turns and files and names what was left out`() {
        val oneEach = MergeBackPreview.Ready(
            parentId = "p",
            parentTitle = "Parent",
            text = "text",
            turns = 1,
            omittedTurns = 0,
            files = listOf("a.ts"),
            moreFiles = 0,
            replacesPending = false,
            token = JsonObject(linkedMapOf()),
        )
        assertEquals("1 turn · 1 file changed", mergeBackPreviewNote(oneEach))

        val many = oneEach.copy(turns = 3, omittedTurns = 2, files = listOf("a.ts", "b.ts"), moreFiles = 4)
        assertEquals("3 turns (2 oldest left out to fit) · 6 files changed", mergeBackPreviewNote(many))
    }

    private fun JsonCodecEncode(vararg fields: Pair<String, app.switchboard.mobile.protocol.JsonValue>): String =
        JsonCodec.encode(JsonObject(linkedMapOf(*fields)))
}
