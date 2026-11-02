package app.switchboard.mobile.domain.remote

import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteSnoozeDecoderTest {
    @Test
    fun `a project session carries its snooze fields`() {
        val snooze = session(
            "snoozedUntil" to JsonNumber("1793566800000"),
            "snoozedAt" to JsonNumber("1793530000000"),
            "snoozePr" to JsonString("github:acme/app#512"),
            "snoozeRev" to JsonNumber("3"),
            "wokeAt" to JsonNull,
            "wokeReason" to JsonNull,
        ).snooze

        assertEquals(
            ChatSnooze.State(
                snoozedUntil = 1793566800000,
                snoozedAt = 1793530000000,
                snoozePr = "github:acme/app#512",
                snoozeRev = 3,
            ),
            snooze,
        )
        assertTrue(snooze.snoozed)
        assertFalse(snooze.woke)
    }

    @Test
    fun `a session from an older backend is not snoozed`() {
        val snooze = session().snooze

        assertEquals(ChatSnooze.State.None, snooze)
        assertFalse(snooze.snoozed)
        assertFalse(snooze.woke)
    }

    @Test
    fun `a woken session keeps its mark and PR line`() {
        val snooze = session(
            "snoozedAt" to JsonNull,
            "snoozeRev" to JsonNumber("4"),
            "wokeAt" to JsonNumber("1793570000000"),
            "wokeReason" to JsonString("pr"),
            "wokePrSummary" to JsonString("PR #512 merged"),
        ).snooze

        assertTrue(snooze.woke)
        assertEquals("pr", snooze.wokeReason)
        assertEquals("PR #512 merged", snooze.wokePrSummary)
    }

    @Test
    fun `the broadcast payload decodes, its prSummary as the woken PR line`() {
        val args = JsonCodec.parse(
            """[{"conversationId":"thread-1","snoozedUntil":null,"snoozedAt":null,"snoozePr":null,""" +
                """"snoozeRev":5,"wokeAt":1793570000000,"wokeReason":"pr","title":"Ignored","prSummary":"PR #512 merged"}]""",
        ) as JsonArray

        val event = ChatSnooze.eventOf(args)

        assertEquals("thread-1", event?.conversationId)
        assertEquals(
            ChatSnooze.State(snoozeRev = 5, wokeAt = 1793570000000, wokeReason = "pr", wokePrSummary = "PR #512 merged"),
            event?.state,
        )
        assertNull(ChatSnooze.eventOf(JsonArray(listOf(obj("snoozeRev" to JsonNumber("1"))))))
        assertNull(ChatSnooze.eventOf(JsonArray(emptyList())))
    }

    @Test
    fun `the snooze and wake answers decode`() {
        assertEquals(
            ChatSnooze.SnoozeAnswer.Snoozed(until = null, pr = "github:acme/app#512", rev = 2),
            ChatSnooze.snoozeAnswer(
                obj("ok" to JsonBoolean(true), "until" to JsonNull, "pr" to JsonString("github:acme/app#512"), "rev" to JsonNumber("2")),
            ),
        )
        assertEquals(
            ChatSnooze.SnoozeAnswer.Refused("needs_you"),
            ChatSnooze.snoozeAnswer(obj("ok" to JsonBoolean(false), "reason" to JsonString("needs_you"))),
        )
        assertEquals(ChatSnooze.WakeAnswer(true, 7), ChatSnooze.wakeAnswer(obj("ok" to JsonBoolean(true), "rev" to JsonNumber("7"))))
        assertEquals(ChatSnooze.WakeAnswer(false, null), ChatSnooze.wakeAnswer(obj("ok" to JsonBoolean(false))))
    }

    @Test
    fun `a snooze request names the preset and the phone`() {
        assertEquals(
            """{"until":1793566800000,"preset":"tonight","surface":"phone"}""",
            JsonCodec.encode(ChatSnooze.request(1793566800000, null, "tonight")),
        )
        assertEquals(
            """{"until":null,"pr":"github:acme/app#512","preset":"pr","surface":"phone"}""",
            JsonCodec.encode(ChatSnooze.request(null, "github:acme/app#512", "pr")),
        )
    }

    private fun session(vararg fields: Pair<String, JsonValue>): SessionSummary = RemoteDecoders.projects(
        JsonArray(
            listOf(
                obj(
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
                                *fields,
                            ),
                        ),
                    ),
                    "workspaceId" to JsonNull,
                ),
            ),
        ),
    ).single().sessions.single()

    private fun obj(vararg fields: Pair<String, JsonValue>) = JsonObject(linkedMapOf(*fields))
}
