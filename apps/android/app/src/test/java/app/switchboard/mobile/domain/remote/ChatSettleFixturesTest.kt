package app.switchboard.mobile.domain.remote

import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue
import java.nio.file.Files
import java.nio.file.Path
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Runs tests/fixtures/chat-settle-cases.json, the cases tests/unit/chat-settle-phones.test.ts checks. */
class ChatSettleFixturesTest {
    private val fixture = loadFixture() as JsonObject

    @Test
    fun undoIsOfferedForTheSameTimeAsOnTheDesktop() {
        assertEquals((fixture.values.getValue("undoMs") as JsonNumber).source.toLong(), ChatSettle.UNDO_MS)
    }

    @Test
    fun anOldBroadcastOffersNoUndo() {
        val cases = section("undoFresh")
        assertTrue(cases.isNotEmpty())
        cases.forEach { case ->
            val age = (case.values.getValue("age") as JsonNumber).source.toLong()
            assertEquals(
                case.str("name"),
                (case.values.getValue("expect") as JsonBoolean).value,
                ChatSettle.isUndoFresh(1_000_000, 1_000_000 + age),
            )
        }
    }

    @Test
    fun noticeTextNamesTheMergedPr() {
        val cases = section("noticeText")
        assertTrue(cases.isNotEmpty())
        cases.forEach { case ->
            val pr = (case.values["prNumber"] as? JsonNumber)?.source?.toInt()
            assertEquals(case.toString(), case.str("expect"), ChatSettle.noticeText(case.str("title"), pr))
        }
    }

    @Test
    fun onlyAMergedPrsSettleBroadcastGetsANotice() {
        section("broadcastNotice").forEach { case ->
            val event = case.values.getValue("event") as JsonObject
            val notice = ChatSettle.broadcastNotice(
                settledAt = (event.values["settledAt"] as? JsonNumber)?.source?.toLong(),
                title = (event.values["title"] as? JsonString)?.value,
                prNumber = (event.values["prNumber"] as? JsonNumber)?.source?.toInt(),
            )
            assertEquals(case.str("name"), (case.values["expect"] as? JsonString)?.value, notice)
        }
    }

    @Test
    fun onlyADoneOrIdleRowCanSettle() {
        val cases = section("canSettle")
        assertTrue(cases.isNotEmpty())
        cases.forEach { case ->
            val status = (case.values["status"] as? JsonString)?.value
            assertEquals(case.toString(), (case.values.getValue("expect") as JsonBoolean).value, ChatSettle.canSettleStatus(status))
        }
    }

    @Test
    fun aBroadcastDecodesWithTheSnoozeItEnded() {
        val event = ChatSettle.eventOf(
            JsonArray(
                listOf(
                    obj(
                        "conversationId" to JsonString("a"),
                        "settledAt" to JsonNumber("700"),
                        "title" to JsonString("Fix"),
                        "prNumber" to JsonNumber("7"),
                        "endedSnooze" to obj(
                            "until" to JsonNull,
                            "pr" to JsonString("github:acme/app#7"),
                            "rev" to JsonNumber("4"),
                        ),
                    ),
                ),
            ),
        )
        val ended = ChatSettle.EndedSnooze(until = null, pr = "github:acme/app#7", rev = 4)
        assertEquals(ChatSettle.Event("a", 700, "Fix", 7, ended), event)
        assertEquals(
            ChatSettle.Undo("mac", "a", 700, "Settled Fix: PR #7 merged", ended),
            ChatSettle.undoOf("mac", event!!, now = 1_000),
        )
        assertNull(ChatSettle.undoOf("mac", ChatSettle.Event("a", 700, "Fix"), now = 1_000))
        // Replayed after a resume, long after its window.
        assertNull(ChatSettle.undoOf("mac", event, now = 700 + 60_000))
        assertEquals(
            obj("until" to JsonNull, "pr" to JsonString("github:acme/app#7"), "expectRev" to JsonNumber("4")),
            ChatSettle.restoreRequest(ended),
        )
    }

    private fun obj(vararg fields: Pair<String, JsonValue>) = JsonObject(linkedMapOf(*fields))

    private fun section(name: String) = (fixture.values.getValue(name) as JsonArray).values.map { it as JsonObject }

    private fun JsonObject.str(key: String) = (values.getValue(key) as JsonString).value

    private fun loadFixture(): JsonValue = JsonCodec.parse(
        String(
            Files.readAllBytes(
                generateSequence(Path.of("").toAbsolutePath()) { it.parent }
                    .map { it.resolve("tests/fixtures/chat-settle-cases.json") }
                    .firstOrNull(Files::exists)
                    ?: error("Missing tests/fixtures/chat-settle-cases.json"),
            ),
            Charsets.UTF_8,
        ),
    )
}
