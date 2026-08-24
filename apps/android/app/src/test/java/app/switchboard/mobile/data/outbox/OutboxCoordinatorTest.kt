package app.switchboard.mobile.data.outbox

import app.switchboard.mobile.domain.outbox.AttachmentDraft
import app.switchboard.mobile.domain.outbox.DeliveryGate
import app.switchboard.mobile.domain.outbox.DeliveryReadiness
import app.switchboard.mobile.domain.outbox.EnqueueResult
import app.switchboard.mobile.domain.outbox.OutboxDeliveryState
import app.switchboard.mobile.domain.outbox.OutgoingTurnDraft
import app.switchboard.mobile.domain.outbox.QueuedTurn
import app.switchboard.mobile.domain.outbox.SendOutcome
import app.switchboard.mobile.domain.outbox.SendReceipt
import app.switchboard.mobile.domain.outbox.StagedAttachment
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OutboxCoordinatorTest {
    @Test
    fun enqueueStagesAndPersistsBeforeVisibleClearOrSend() {
        val fixture = Fixture()

        val result = fixture.coordinator.enqueue(
            draft("thread-a", attachments = listOf(AttachmentDraft("content://photo", "image/png"))),
        )

        assertTrue(result is EnqueueResult.Durable)
        assertEquals(
            listOf("stage:content://photo", "insert:origin-1", "visible:origin-1", "send:origin-1"),
            fixture.log.take(4),
        )
        val sent = fixture.sender.sent.single()
        assertEquals("origin-1", sent.origin)
        assertEquals("remote_origin-1", sent.bubbleId)
        assertEquals("private://photo", sent.attachments.single().privateUri)
    }

    @Test
    fun failedDurableInsertNeverClearsComposerOrBecomesSendable() {
        val fixture = Fixture()
        fixture.store.failInsert = true

        val result = fixture.coordinator.enqueue(draft("thread-a"))

        assertTrue(result is EnqueueResult.StorageFailure)
        assertFalse(fixture.log.any { it.startsWith("visible:") })
        assertTrue(fixture.sender.sent.isEmpty())
        assertTrue(fixture.coordinator.records().isEmpty())
    }

    @Test
    fun eachThreadIsFifoWhileDifferentThreadsSendInParallel() {
        val fixture = Fixture()
        fixture.coordinator.enqueue(draft("thread-a", text = "A1"))
        fixture.coordinator.enqueue(draft("thread-a", text = "A2"))
        fixture.coordinator.enqueue(draft("thread-b", text = "B1"))

        assertEquals(listOf("A1", "B1"), fixture.sender.sent.map { it.text })

        fixture.sender.complete("origin-1", SendOutcome.Accepted(SendReceipt.legacy()))
        assertEquals(listOf("A1", "B1", "A2"), fixture.sender.sent.map { it.text })
        assertEquals(1, fixture.sender.maxInFlightByThread)
    }

    @Test
    fun synchronousSenderCallbacksCannotDoublePumpOrReorderAThread() {
        val fixture = Fixture()
        fixture.sender.synchronousOutcome = SendOutcome.Accepted(SendReceipt.legacy())

        fixture.coordinator.enqueue(draft("thread-a", text = "A1"))
        fixture.coordinator.enqueue(draft("thread-a", text = "A2"))
        fixture.coordinator.enqueue(draft("thread-b", text = "B1"))

        assertEquals(listOf("A1", "A2", "B1"), fixture.sender.sent.map { it.text })
        assertEquals(1, fixture.sender.maxInFlightByThread)
        assertTrue(fixture.coordinator.records().isEmpty())
    }

    @Test
    fun readinessEditingAndBackoffGateDeliveryWithoutDroppingTheHead() {
        val fixture = Fixture()
        fixture.environment.gates["thread-a"] = DeliveryGate(DeliveryReadiness.Offline, false)
        fixture.coordinator.enqueue(draft("thread-a"))
        assertTrue(fixture.sender.sent.isEmpty())

        fixture.environment.gates["thread-a"] = DeliveryGate(DeliveryReadiness.Ready, false)
        fixture.coordinator.setEditing("origin-1", true)
        fixture.coordinator.pump()
        assertTrue(fixture.sender.sent.isEmpty())

        fixture.coordinator.setEditing("origin-1", false)
        assertEquals(listOf("origin-1"), fixture.sender.sent.map { it.origin })
    }

    @Test
    fun retryableFailurePersistsAttemptAndDeadlineBeforeScheduling() {
        val fixture = Fixture()
        fixture.coordinator.enqueue(draft("thread-a"))
        fixture.sender.complete("origin-1", SendOutcome.Retryable("network closed"))

        val retried = fixture.coordinator.records().single()
        assertEquals(1, retried.attempts)
        assertEquals(2_000, retried.nextAttemptAtMs)
        assertTrue(fixture.log.indexOf("update:origin-1:pending:1") < fixture.log.indexOf("schedule:origin-1:1000"))

        fixture.clock.now = 2_000
        fixture.scheduler.fire("origin-1")
        assertEquals(2, fixture.sender.sent.size)
        assertEquals("origin-1", fixture.sender.sent.last().origin)
    }

    @Test
    fun ambiguousTransportRetriesOnlyWithDurableBackendDedupeCapability() {
        val capable = Fixture()
        capable.environment.gates["thread-a"] = DeliveryGate(DeliveryReadiness.Ready, true)
        capable.coordinator.enqueue(draft("thread-a"))
        capable.sender.complete("origin-1", SendOutcome.TransportAmbiguous("timeout"))
        assertTrue(capable.coordinator.records().single().deliveryState is OutboxDeliveryState.Pending)
        assertEquals(1, capable.scheduler.tasks.size)

        val legacy = Fixture()
        legacy.environment.gates["thread-a"] = DeliveryGate(DeliveryReadiness.Ready, false)
        legacy.coordinator.enqueue(draft("thread-a"))
        legacy.sender.complete("origin-1", SendOutcome.TransportAmbiguous("timeout"))
        assertTrue(legacy.coordinator.records().single().deliveryState is OutboxDeliveryState.Ambiguous)
        assertTrue(legacy.scheduler.tasks.isEmpty())
        assertTrue(legacy.log.any { it == "ambiguous:origin-1" })
    }

    @Test
    fun throwingLegacySenderFreezesAmbiguousInsteadOfResending() {
        val fixture = Fixture()
        fixture.environment.gates["thread-a"] = DeliveryGate(DeliveryReadiness.Ready, false)
        fixture.sender.throwOnSend = true

        fixture.coordinator.enqueue(draft("thread-a"))
        fixture.coordinator.pump()

        assertEquals(1, fixture.sender.sent.size)
        assertTrue(fixture.coordinator.records().single().deliveryState is OutboxDeliveryState.Ambiguous)
        assertTrue(fixture.scheduler.tasks.isEmpty())
    }

    @Test
    fun acceptedTurnBecomesDurablyNonResendableBeforeBestEffortDeletion() {
        val fixture = Fixture()
        fixture.store.failDelete = true
        fixture.coordinator.enqueue(draft("thread-a"))

        fixture.sender.complete("origin-1", SendOutcome.Accepted(SendReceipt.legacy()))

        val kept = fixture.coordinator.records().single()
        assertTrue(kept.deliveryState is OutboxDeliveryState.Acknowledged)
        assertTrue(fixture.log.indexOf("update:origin-1:acknowledged:0") < fixture.log.indexOf("ack:origin-1"))
        assertTrue(fixture.log.indexOf("ack:origin-1") < fixture.log.indexOf("delete:origin-1"))

        val restarted = Fixture(store = fixture.store)
        restarted.coordinator.hydrate()
        assertTrue(restarted.sender.sent.isEmpty())
    }

    @Test
    fun permanentFailureIsPersistedAndVisibleUntilExplicitCleanupSucceeds() {
        val fixture = Fixture()
        fixture.coordinator.enqueue(draft("thread-a"))
        fixture.sender.complete("origin-1", SendOutcome.Permanent("No session"))

        val terminal = fixture.coordinator.records().single()
        assertTrue(terminal.deliveryState is OutboxDeliveryState.Terminal)
        assertTrue(fixture.log.indexOf("update:origin-1:terminal:0") < fixture.log.indexOf("terminal:origin-1"))
        assertFalse(fixture.sender.sent.size > 1)

        fixture.store.failDelete = true
        fixture.coordinator.dismiss("origin-1")
        assertEquals(1, fixture.coordinator.records().size)
        fixture.store.failDelete = false
        fixture.coordinator.dismiss("origin-1")
        assertTrue(fixture.coordinator.records().isEmpty())
    }

    @Test
    fun terminalPersistenceFailureBlocksThatThreadAndSurfacesStorageRecovery() {
        val fixture = Fixture()
        fixture.coordinator.enqueue(draft("thread-a", text = "A1"))
        fixture.coordinator.enqueue(draft("thread-a", text = "A2"))
        fixture.store.failUpdate = true

        fixture.sender.complete("origin-1", SendOutcome.Permanent("refused"))

        assertTrue(fixture.log.any { it == "storage-blocked:origin-1" })
        assertEquals(listOf("A1"), fixture.sender.sent.map { it.text })
    }

    @Test
    fun hydrationRestoresPendingRowsOldestFirstAndNeverResendsTerminalRows() {
        val store = FakeStore()
        store.rows["terminal"] = queued("terminal", "thread-a", 0, OutboxDeliveryState.Terminal("refused"))
        store.rows["newer"] = queued("newer", "thread-a", 20)
        store.rows["other"] = queued("other", "thread-b", 15)
        store.rows["older"] = queued("older", "thread-a", 10)
        val fixture = Fixture(store)

        fixture.coordinator.hydrate()

        assertEquals(listOf("older", "other"), fixture.sender.sent.map { it.origin })
        fixture.sender.complete("older", SendOutcome.Accepted(SendReceipt.legacy()))
        assertEquals(listOf("older", "other", "newer"), fixture.sender.sent.map { it.origin })
        assertTrue(fixture.log.any { it == "terminal:terminal" })
    }

    @Test
    fun explicitRetryPreservesOriginAndBubbleIdentity() {
        val fixture = Fixture()
        fixture.coordinator.enqueue(draft("thread-a"))
        fixture.sender.complete("origin-1", SendOutcome.Ambiguous("unknown"))

        assertTrue(fixture.coordinator.retry("origin-1"))

        val resent = fixture.sender.sent.last()
        assertEquals("origin-1", resent.origin)
        assertEquals("remote_origin-1", resent.bubbleId)
        assertTrue(resent.deliveryState is OutboxDeliveryState.Pending)
    }

    @Test
    fun backendResolvedAbandonmentRemovesTheBlockerWithoutResending() {
        val fixture = Fixture()
        fixture.coordinator.enqueue(draft("thread-a"))
        fixture.sender.complete("origin-1", SendOutcome.Ambiguous("unknown"))
        val sendsBeforeResolution = fixture.sender.sent.size

        assertTrue(fixture.coordinator.abandonResolved("origin-1"))

        assertTrue(fixture.coordinator.records().isEmpty())
        assertEquals(sendsBeforeResolution, fixture.sender.sent.size)
        assertTrue(fixture.log.any { it == "delete:origin-1" })
    }

    @Test
    fun inFlightPendingTurnCannotEnterEditingOrReplaceItsPayload() {
        val fixture = Fixture()
        fixture.coordinator.enqueue(
            draft(
                "thread-a",
                text = "before",
                attachments = listOf(AttachmentDraft("content://old", "image/png")),
            ),
        )

        assertEquals(null, fixture.coordinator.beginEdit("origin-1"))
        val replaced = fixture.coordinator.replace(
            "origin-1",
            draft(
                "thread-a",
                text = "after",
                attachments = listOf(AttachmentDraft("content://new", "image/png")),
            ),
        )

        assertTrue(replaced is EnqueueResult.StorageFailure)
        val current = fixture.coordinator.records().single()
        assertEquals("before", current.text)
        assertEquals("private://old", current.attachments.single().privateUri)
        assertFalse(fixture.log.contains("discard:private://old"))
    }

    @Test
    fun ambiguousTurnCannotEnterEditingOrReplaceItsPayload() {
        val fixture = Fixture()
        fixture.coordinator.enqueue(
            draft(
                "thread-a",
                text = "before",
                attachments = listOf(AttachmentDraft("content://old", "image/png")),
            ),
        )
        fixture.sender.complete("origin-1", SendOutcome.Ambiguous("unknown"))

        assertEquals(null, fixture.coordinator.beginEdit("origin-1"))
        val replaced = fixture.coordinator.replace(
            "origin-1",
            draft(
                "thread-a",
                text = "after",
                attachments = listOf(AttachmentDraft("content://new", "image/png")),
            ),
        )

        assertTrue(replaced is EnqueueResult.StorageFailure)
        val current = fixture.coordinator.records().single()
        assertEquals("before", current.text)
        assertEquals("private://old", current.attachments.single().privateUri)
        assertTrue(current.deliveryState is OutboxDeliveryState.Ambiguous)
        assertFalse(fixture.log.contains("discard:private://old"))
    }

    @Test
    fun ambiguousTurnCannotBeDismissedAndRetainsItsAttachments() {
        val fixture = Fixture()
        fixture.coordinator.enqueue(
            draft(
                "thread-a",
                attachments = listOf(AttachmentDraft("content://photo", "image/png")),
            ),
        )
        fixture.sender.complete("origin-1", SendOutcome.Ambiguous("unknown"))

        fixture.coordinator.dismiss("origin-1")

        val retained = fixture.coordinator.records().single()
        assertEquals("private://photo", retained.attachments.single().privateUri)
        assertTrue(retained.deliveryState is OutboxDeliveryState.Ambiguous)
        assertFalse(fixture.log.contains("delete:origin-1"))
        assertFalse(fixture.log.contains("discard:private://photo"))
    }

    @Test
    fun replacementDiscardsOldAttachmentsOnlyAfterItsDatabaseCommit() {
        val fixture = Fixture()
        fixture.environment.gates["thread-a"] = DeliveryGate(DeliveryReadiness.Offline, false)
        fixture.coordinator.enqueue(
            draft(
                "thread-a",
                attachments = listOf(AttachmentDraft("content://old", "image/png")),
            ),
        )
        fixture.coordinator.beginEdit("origin-1")
        fixture.store.failReplace = true

        val failed = fixture.coordinator.replace(
            "origin-1",
            draft(
                "thread-a",
                attachments = listOf(AttachmentDraft("content://new", "image/png")),
            ),
        )

        assertTrue(failed is EnqueueResult.StorageFailure)
        assertEquals("private://old", fixture.coordinator.records().single().attachments.single().privateUri)
        assertTrue(fixture.log.indexOf("replace:origin-1") < fixture.log.indexOf("discard:private://new"))
        assertFalse(fixture.log.contains("discard:private://old"))

        fixture.store.failReplace = false
        fixture.coordinator.replace(
            "origin-1",
            draft(
                "thread-a",
                attachments = listOf(AttachmentDraft("content://newer", "image/png")),
            ),
        )
        assertTrue(fixture.log.indexOf("replace:origin-1") < fixture.log.indexOf("discard:private://old"))
    }

    private fun draft(
        threadId: String,
        text: String = "hello",
        attachments: List<AttachmentDraft> = emptyList(),
    ) = OutgoingTurnDraft("mac-a", threadId, text, attachments, "sandbox", 1_000)

    private fun queued(
        origin: String,
        threadId: String,
        createdAt: Long,
        state: OutboxDeliveryState = OutboxDeliveryState.Pending,
    ) = QueuedTurn(
        connectionId = "mac-a",
        threadId = threadId,
        origin = origin,
        bubbleId = "remote_$origin",
        text = origin,
        attachments = emptyList(),
        runtimeMode = "sandbox",
        createdAtMs = createdAt,
        attempts = 0,
        nextAttemptAtMs = 0,
        deliveryState = state,
    )

    private class Fixture(
        val store: FakeStore = FakeStore(),
    ) {
        val log = store.log
        val clock = FakeClock()
        val scheduler = FakeScheduler(log)
        val sender = FakeSender(log)
        val environment = FakeEnvironment()
        private val ids = SequenceIds()
        private val observer = FakeObserver(log)
        private val stager = FakeStager(log)
        val coordinator = OutboxCoordinator(store, stager, sender, environment, clock, scheduler, ids, observer)
    }

    private class FakeStore : OutboxStore {
        val rows = linkedMapOf<String, QueuedTurn>()
        val log = mutableListOf<String>()
        var failInsert = false
        var failUpdate = false
        var failDelete = false
        var failReplace = false

        override fun insert(turn: QueuedTurn): OutboxStorageResult {
            log += "insert:${turn.origin}"
            if (failInsert) return OutboxStorageResult.Failure("disk full")
            rows[turn.origin] = turn
            return OutboxStorageResult.Success
        }

        override fun update(turn: QueuedTurn): OutboxStorageResult {
            log += "update:${turn.origin}:${turn.deliveryState.label}:${turn.attempts}"
            if (failUpdate) return OutboxStorageResult.Failure("write failed")
            rows[turn.origin] = turn
            return OutboxStorageResult.Success
        }

        override fun replace(turn: QueuedTurn): OutboxStorageResult {
            log += "replace:${turn.origin}"
            if (failReplace) return OutboxStorageResult.Failure("replace failed")
            if (turn.origin !in rows) return OutboxStorageResult.Failure("missing")
            rows[turn.origin] = turn
            return OutboxStorageResult.Success
        }

        override fun delete(origin: String): OutboxStorageResult {
            log += "delete:$origin"
            if (failDelete) return OutboxStorageResult.Failure("delete failed")
            rows.remove(origin)
            return OutboxStorageResult.Success
        }

        override fun load(): OutboxLoadResult = OutboxLoadResult.Success(rows.values.toList())
    }

    private class FakeStager(private val log: MutableList<String>) : AttachmentStager {
        override fun stage(attachments: List<AttachmentDraft>): AttachmentStageResult {
            attachments.forEach { log += "stage:${it.sourceUri}" }
            return AttachmentStageResult.Success(
                attachments.map {
                    StagedAttachment("private://${it.sourceUri.removePrefix("content://")}", it.mimeType)
                },
            )
        }

        override fun discard(attachments: List<StagedAttachment>) {
            attachments.forEach { log += "discard:${it.privateUri}" }
        }
    }

    private class FakeSender(private val log: MutableList<String>) : OutboxSender {
        val sent = mutableListOf<QueuedTurn>()
        private val callbacks = mutableMapOf<String, (SendOutcome) -> Unit>()
        private val inFlight = mutableMapOf<String, Int>()
        var maxInFlightByThread = 0
        var synchronousOutcome: SendOutcome? = null
        var throwOnSend = false

        override fun send(turn: QueuedTurn, callback: (SendOutcome) -> Unit) {
            log += "send:${turn.origin}"
            sent += turn
            if (throwOnSend) throw IllegalStateException("socket failed after send")
            val count = (inFlight[turn.threadId] ?: 0) + 1
            inFlight[turn.threadId] = count
            maxInFlightByThread = maxOf(maxInFlightByThread, count)
            val immediate = synchronousOutcome
            if (immediate != null) {
                inFlight[turn.threadId] = count - 1
                callback(immediate)
            } else {
                callbacks[turn.origin] = { outcome ->
                    inFlight[turn.threadId] = (inFlight[turn.threadId] ?: 1) - 1
                    callback(outcome)
                }
            }
        }

        fun complete(origin: String, outcome: SendOutcome) {
            callbacks.remove(origin)!!(outcome)
        }

        fun callback(origin: String): (SendOutcome) -> Unit = callbacks.getValue(origin)
    }

    private class FakeEnvironment : OutboxEnvironment {
        val gates = mutableMapOf<String, DeliveryGate>()
        override fun gate(turn: QueuedTurn): DeliveryGate =
            gates[turn.threadId] ?: DeliveryGate(DeliveryReadiness.Ready, false)
    }

    private class FakeClock : OutboxClock {
        var now = 1_000L
        override fun nowMs(): Long = now
    }

    private class FakeScheduler(private val log: MutableList<String>) : OutboxRetryScheduler {
        val tasks = mutableMapOf<String, () -> Unit>()
        override fun schedule(origin: String, delayMs: Long, callback: () -> Unit) {
            log += "schedule:$origin:$delayMs"
            tasks[origin] = callback
        }
        override fun cancel(origin: String) {
            tasks.remove(origin)
        }
        fun fire(origin: String) = tasks.remove(origin)!!()
    }

    private class SequenceIds : OutboxIdSource {
        var next = 1
        override fun nextOrigin(): String = "origin-${next++}"
    }

    private class FakeObserver(private val log: MutableList<String>) : OutboxObserver {
        override fun onDurablyEnqueued(turn: QueuedTurn) { log += "visible:${turn.origin}" }
        override fun onAcknowledged(turn: QueuedTurn) { log += "ack:${turn.origin}" }
        override fun onTerminal(turn: QueuedTurn, reason: String) { log += "terminal:${turn.origin}" }
        override fun onAmbiguous(turn: QueuedTurn, reason: String) { log += "ambiguous:${turn.origin}" }
        override fun onStorageBlocked(turn: QueuedTurn, reason: String) { log += "storage-blocked:${turn.origin}" }
        override fun onHydrationFailure(reason: String) { log += "hydrate-failed" }
    }
}
