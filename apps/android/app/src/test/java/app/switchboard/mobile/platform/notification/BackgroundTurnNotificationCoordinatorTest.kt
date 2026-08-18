package app.switchboard.mobile.platform.notification

import app.switchboard.mobile.platform.protocol.TransportScope
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.RuntimeEventKind
import app.switchboard.mobile.protocol.RuntimeEventPayload
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BackgroundTurnNotificationCoordinatorTest {
    private val scope = TransportScope("device-1", "machine-1", 7)
    private var foreground = false
    private var currentScope: TransportScope? = scope
    private val posted = mutableListOf<TurnCompletionNotification>()
    private val coordinator = BackgroundTurnNotificationCoordinator(
        isForeground = { foreground },
        currentScope = { currentScope },
        metadata = { _, _ -> NotificationThreadMetadata("Release work", "/work/switchboard", "Studio Mac") },
        notifier = TurnCompletionNotifier { notification ->
            posted += notification
            true
        },
    )

    @Test
    fun `background current generation completion posts privacy-safe parity copy`() {
        assertTrue(coordinator.onRuntimeEvent(scope, completion("turn-1", durationMs = 1_400)))

        assertEquals(1, posted.size)
        assertEquals("Switchboard", posted.single().title)
        assertEquals("Done in 1.4s", posted.single().body)
        assertEquals(
            NotificationThreadRoute(
                connectionId = "machine-1",
                threadId = "thread-1",
                titleHint = "Release work",
                projectPathHint = "/work/switchboard",
                connectionLabelHint = "Studio Mac",
            ),
            posted.single().route,
        )
        val rendered = posted.single().toString()
        assertFalse(rendered.contains("token", ignoreCase = true))
        assertFalse(rendered.contains("message", ignoreCase = true))
    }

    @Test
    fun `foreground and stale generation completions are ignored`() {
        foreground = true
        assertFalse(coordinator.onRuntimeEvent(scope, completion("turn-1")))

        foreground = false
        currentScope = scope.copy(generation = 8)
        assertFalse(coordinator.onRuntimeEvent(scope, completion("turn-2")))
        assertEquals(emptyList<TurnCompletionNotification>(), posted)
    }

    @Test
    fun `non completion malformed and duplicate completion events are ignored`() {
        assertFalse(coordinator.onRuntimeEvent(scope, event("content", "thread-1", emptyMap())))
        assertFalse(coordinator.onRuntimeEvent(scope, event("turn.completed", "", emptyMap())))
        assertTrue(coordinator.onRuntimeEvent(scope, completion("turn-1")))
        assertFalse(coordinator.onRuntimeEvent(scope, completion("turn-1")))
        assertEquals(1, posted.size)
    }

    @Test
    fun `duration formatting matches existing notification vocabulary`() {
        assertEquals("Done", TurnCompletionNotificationPolicy.body(null))
        assertEquals("Done", TurnCompletionNotificationPolicy.body(0))
        assertEquals("Done in 0.2s", TurnCompletionNotificationPolicy.body(200))
        assertEquals("Done in 1m 5s", TurnCompletionNotificationPolicy.body(65_000))
        assertEquals("Done in 1h 5m", TurnCompletionNotificationPolicy.body(3_900_000))
    }

    @Test
    fun `notification delivery failure is best effort and does not poison dedupe`() {
        var attempts = 0
        val coordinator = BackgroundTurnNotificationCoordinator(
            isForeground = { false },
            currentScope = { scope },
            metadata = { _, _ -> NotificationThreadMetadata() },
            notifier = TurnCompletionNotifier {
                attempts += 1
                if (attempts == 1) error("notification subsystem unavailable")
                true
            },
        )

        assertFalse(coordinator.onRuntimeEvent(scope, completion("turn-1")))
        assertTrue(coordinator.onRuntimeEvent(scope, completion("turn-1")))
        assertEquals(2, attempts)
    }

    private fun completion(turnId: String, durationMs: Long? = null): RuntimeEventPayload =
        event(
            "turn.completed",
            "thread-1",
            buildMap {
                put("turnId", JsonString(turnId))
                durationMs?.let { put("durationMs", JsonNumber(it.toString())) }
            },
        )

    private fun event(
        type: String,
        threadId: String,
        extra: Map<String, app.switchboard.mobile.protocol.JsonValue>,
    ) = RuntimeEventPayload(
        type = type,
        threadId = threadId,
        kind = RuntimeEventKind.Known,
        raw = JsonObject(
            linkedMapOf<String, app.switchboard.mobile.protocol.JsonValue>(
                "type" to JsonString(type),
                "threadId" to JsonString(threadId),
            ).apply { putAll(extra) },
        ),
    )
}
