package app.switchboard.mobile.data.remote

import app.switchboard.mobile.domain.remote.ChatSnooze
import app.switchboard.mobile.domain.remote.SessionSummary
import app.switchboard.mobile.protocol.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Test

class ChatSnoozeStoreTest {
    @Test
    fun `a broadcast older than the state held is dropped, a same revision one is taken`() {
        val store = ChatSnoozeStore()
        store.put("mac", "a", state(rev = 3, until = 1_000))

        store.applyEvent("mac", ChatSnooze.Event("a", state(rev = 2, until = 9_000)))
        assertEquals(1_000L, store.of("mac", "a")?.snoozedUntil)

        store.applyEvent("mac", ChatSnooze.Event("a", ChatSnooze.State(snoozeRev = 3)))
        assertEquals(ChatSnooze.State(snoozeRev = 3), store.of("mac", "a"))
    }

    @Test
    fun `the project list's copy replaces one it is not older than`() {
        val store = ChatSnoozeStore()
        store.put("mac", "kept", state(rev = 5, until = 1_000))
        store.put("mac", "replaced", state(rev = 1, until = 1_000))

        store.seed("mac", listOf(session("kept", state(rev = 4, until = 2_000)), session("replaced", ChatSnooze.State(snoozeRev = 1))))

        assertEquals(1_000L, store.of("mac", "kept")?.snoozedUntil)
        assertEquals(ChatSnooze.State(snoozeRev = 1), store.of("mac", "replaced"))
        assertEquals(null, store.of("pixel", "kept"))
    }

    private fun state(rev: Long, until: Long?) =
        ChatSnooze.State(snoozedUntil = until, snoozedAt = 10, snoozeRev = rev)

    private fun session(id: String, snooze: ChatSnooze.State) = SessionSummary(
        id = id,
        source = "codex",
        title = id,
        startedAt = 1,
        messageCount = 1,
        filePath = "/tmp/$id.jsonl",
        raw = JsonObject(linkedMapOf()),
        snooze = snooze,
    )
}
