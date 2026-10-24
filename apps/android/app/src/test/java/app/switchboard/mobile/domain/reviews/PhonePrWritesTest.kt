package app.switchboard.mobile.domain.reviews

import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import java.nio.file.Files
import java.nio.file.Path
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The digest vectors are the ones pinned in tests/unit/pr-write-scope.test.ts,
 * and the copy and limit notes match tests/fixtures/phone-pr-write-copy.json,
 * which tests/unit/phone-pr-write-copy-fixture.test.ts keeps equal to the TS.
 */
class PhonePrWritesTest {
    private val replySheet = PhonePrWriteSheet(
        account = "tejasnafde",
        ref = PrRef("github", "tejasnafde", "switchboard", 161),
        action = PhonePrWriteAction.Reply,
        conversationId = "PRRT_1",
        event = null,
        text = "Fixed in the next commit.",
        writeId = "w_0123456789abcdef",
    )

    @Test
    fun digestMatchesThePinnedVectors() {
        assertEquals("80257400afe1485a", PhonePrWrites.digest(replySheet))
        assertEquals(
            "41ea42c76939646c",
            PhonePrWrites.digest(
                replySheet.copy(
                    account = "Jane Doe (jdoe)",
                    ref = PrRef("bitbucket", "geoiq", "ssg-bot-v2", 612),
                    action = PhonePrWriteAction.Review,
                    conversationId = null,
                    event = ReviewEvent.Approve,
                    text = "Looks good. ✓ naïve",
                ),
            ),
        )
    }

    @Test
    fun everyShownFieldChangesTheDigest() {
        val base = PhonePrWrites.digest(replySheet)
        listOf(
            replySheet.copy(account = "someone"),
            replySheet.copy(ref = replySheet.ref.copy(number = 162)),
            replySheet.copy(conversationId = "PRRT_2"),
            replySheet.copy(text = "Fixed in the next commit"),
            replySheet.copy(writeId = "w_0123456789abcdeg"),
            replySheet.copy(action = PhonePrWriteAction.Comment),
        ).forEach { assertNotEquals(it.toString(), base, PhonePrWrites.digest(it)) }
    }

    @Test
    fun mintedWriteIdsAreValidAndFresh() {
        val ids = (1..200).map { PhonePrWrites.mintWriteId() }
        ids.forEach { assertTrue(it, PhonePrWrites.isWriteId(it)) }
        assertEquals(ids.size, ids.toSet().size)
    }

    @Test
    fun reviewVerdictsFollowTheViewerAndState() {
        val viewer = PrViewer(isAuthor = false, isRequestedReviewer = true, hasReviewed = false, hasCommented = false)
        assertEquals(ReviewEvent.entries.toList(), PhonePrWrites.reviewEventsFor(viewer))
        assertEquals(listOf(ReviewEvent.Comment), PhonePrWrites.reviewEventsFor(viewer.copy(isAuthor = true)))
        assertEquals("GitHub needs a summary to request changes.", PhonePrWrites.reviewSubmitProblem("github", ReviewEvent.RequestChanges, "  "))
        assertEquals("Say what should change.", PhonePrWrites.reviewSubmitProblem("bitbucket", ReviewEvent.RequestChanges, ""))
        assertEquals("Write a summary or add a comment on a line first.", PhonePrWrites.reviewSubmitProblem("github", ReviewEvent.Comment, ""))
        assertNull(PhonePrWrites.reviewSubmitProblem("github", ReviewEvent.Approve, ""))
        assertEquals("The summary is too long.", PhonePrWrites.reviewSubmitProblem("github", ReviewEvent.Approve, "x".repeat(60_001)))
    }

    @Test
    fun copyAndLimitNotesMatchTheSharedFixture() {
        val fixture = loadFixture() as JsonObject
        val copy = (fixture.values.getValue("copy") as JsonObject).values.mapValues { (it.value as JsonString).value }
        assertEquals(copy, PhonePrWrites.Copy.all)
        assertEquals((fixture.values.getValue("maxChars") as JsonNumber).source.toInt(), PhonePrWrites.TEXT_MAX_CHARS)
        val notes = (fixture.values.getValue("limitNotes") as JsonArray).values.map { it as JsonObject }
        assertTrue(notes.isNotEmpty())
        notes.forEach { case ->
            val host = (case.values.getValue("host") as JsonString).value
            val length = (case.values.getValue("length") as JsonNumber).source.toInt()
            val expected = when (val note = case.values.getValue("note")) {
                JsonNull -> null
                is JsonString -> note.value
                else -> error("bad note")
            }
            assertEquals("$host $length", expected, PhonePrWrites.prTextLimitNote(host, length))
        }
    }

    @Test
    fun noEmDashInTheCopy() {
        PhonePrWrites.Copy.all.values.forEach { assertTrue(it, '\u2014' !in it) }
    }

    @Test
    fun conversationLocation() {
        fun conversation(path: String?, line: Long?, start: Long? = null) =
            PrConversation("c", path, line, start, resolved = false, outdated = false, comments = emptyList())
        assertEquals("General", conversation(null, null).location)
        assertEquals("a.kt", conversation("a.kt", null).location)
        assertEquals("a.kt:9", conversation("a.kt", 9).location)
        assertEquals("a.kt:3-9", conversation("a.kt", 9, 3).location)
    }

    private fun loadFixture() = JsonCodec.parse(
        String(
            Files.readAllBytes(
                generateSequence(Path.of("").toAbsolutePath()) { it.parent }
                    .map { it.resolve("tests/fixtures/phone-pr-write-copy.json") }
                    .firstOrNull(Files::exists)
                    ?: error("Missing tests/fixtures/phone-pr-write-copy.json"),
            ),
            Charsets.UTF_8,
        ),
    )
}
