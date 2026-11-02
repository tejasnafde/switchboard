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
        assertEquals(ChatSnooze.State(snoozeRev = 3, unsettled = true), store.of("mac", "a"))
    }

    @Test
    fun `a snooze held here marks the list's settled time stale until the list catches up`() {
        val store = ChatSnoozeStore()
        store.seed("mac", listOf(session("a", ChatSnooze.State(snoozeRev = 1))))
        assertEquals(false, store.of("mac", "a")?.unsettled)

        store.applyEvent("mac", ChatSnooze.Event("a", state(rev = 2, until = 1_000)))
        store.applyEvent("mac", ChatSnooze.Event("a", ChatSnooze.State(snoozeRev = 3, wokeAt = 1_000, wokeReason = "time")))
        assertEquals(true, store.of("mac", "a")?.unsettled)

        store.seed("mac", listOf(session("a", ChatSnooze.State(snoozeRev = 3, wokeAt = 1_000, wokeReason = "time"))))
        assertEquals(false, store.of("mac", "a")?.unsettled)
    }

    @Test
    fun `a saved list at the same revision does not bring back a Woke mark cleared here`() {
        val store = ChatSnoozeStore()
        val woke = ChatSnooze.State(snoozeRev = 4, wokeAt = 1_000, wokeReason = "time")
        store.put("mac", "a", ChatSnooze.State(snoozeRev = 4))

        store.seed("mac", listOf(session("a", woke)))
        assertEquals(false, store.of("mac", "a")?.woke)

        store.seed("mac", listOf(session("a", woke.copy(snoozeRev = 5))))
        assertEquals(true, store.of("mac", "a")?.woke)
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

    @Test
    fun `forgetting a machine's presets brings back the defaults`() {
        val store = ChatSnoozeStore()
        val soon = listOf(ChatSnooze.PresetSpec.Duration("Soon", 30))
        store.putPresets("mac", soon)
        store.putPresets("pixel", soon)

        store.forgetPresets("mac")

        assertEquals(ChatSnooze.DEFAULT_PRESETS, store.presetsOf("mac"))
        assertEquals(soon, store.presetsOf("pixel"))
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
