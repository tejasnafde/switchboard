package app.switchboard.mobile.data.outbox

import app.switchboard.mobile.data.remote.RemoteRpc
import app.switchboard.mobile.data.remote.SwitchboardRemoteClient
import app.switchboard.mobile.domain.outbox.AttachmentDraft
import app.switchboard.mobile.domain.outbox.DeliveryReadiness
import app.switchboard.mobile.domain.outbox.EnqueueResult
import app.switchboard.mobile.domain.outbox.OutboxDeliveryState
import app.switchboard.mobile.domain.outbox.OutgoingTurnDraft
import app.switchboard.mobile.domain.outbox.QueuedTurn
import app.switchboard.mobile.domain.outbox.StagedAttachment
import app.switchboard.mobile.platform.protocol.Cancelable
import app.switchboard.mobile.platform.protocol.RequestSubmission
import app.switchboard.mobile.platform.protocol.RpcFailure
import app.switchboard.mobile.platform.protocol.RpcOutcome
import app.switchboard.mobile.platform.protocol.TransportScope
import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.RuntimeEventPayload
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class OutboxRuntimeTest {
    @Test
    fun startupHydratesOnceAndFleetReadyTransitionSendsWithoutDuplicateWake() {
        val store = FakeStore(queued("persisted"))
        val fixture = Fixture(store)
        fixture.availability.ready = false

        fixture.runtime.onStartupReady()
        fixture.runtime.onStartupReady()
        assertEquals(1, store.loads)
        assertEquals(0, fixture.rpc.invocations)

        fixture.availability.ready = true
        fixture.runtime.onFleetChanged()
        fixture.runtime.onFleetChanged()
        assertEquals(1, fixture.rpc.invocations)
    }

    @Test
    fun enqueueWakesReadyRuntimeAndKeepsExistingCoordinatorFifo() {
        val fixture = Fixture(FakeStore())
        fixture.runtime.onStartupReady()

        assertTrue(fixture.runtime.enqueue(draft("thread-a", "A1")) is EnqueueResult.Durable)
        assertTrue(fixture.runtime.enqueue(draft("thread-a", "A2")) is EnqueueResult.Durable)
        assertTrue(fixture.runtime.enqueue(draft("thread-b", "B1")) is EnqueueResult.Durable)

        assertEquals(listOf("A1", "B1"), fixture.rpc.messages)
    }

    @Test
    fun acknowledgedCleanupFailureSurvivesRestartWithoutResending() {
        val store = FakeStore(queued("persisted")).apply { failDelete = true }
        val first = Fixture(store)
        first.rpc.synchronousOutcome = RpcOutcome.Success(null)

        first.runtime.onStartupReady()
        assertEquals(1, first.rpc.invocations)
        assertTrue(store.rows.getValue("persisted").deliveryState is OutboxDeliveryState.Acknowledged)

        val restarted = Fixture(store)
        restarted.rpc.synchronousOutcome = RpcOutcome.Success(null)
        restarted.runtime.onStartupReady()

        assertEquals(0, restarted.rpc.invocations)
        assertTrue(restarted.runtime.records().single().deliveryState is OutboxDeliveryState.Acknowledged)
    }

    @Test
    fun legacyAmbiguousDeliveryNeverSchedulesOrResends() {
        val store = FakeStore(queued("legacy"))
        val fixture = Fixture(store)
        fixture.availability.durable = false
        fixture.runtime.onStartupReady()

        fixture.rpc.reply(RpcOutcome.Failure(RpcFailure.Timeout))
        fixture.runtime.onFleetChanged()

        assertEquals(1, fixture.rpc.invocations)
        assertTrue(store.rows.getValue("legacy").deliveryState is OutboxDeliveryState.Ambiguous)
        assertTrue(fixture.scheduler.tasks.isEmpty())
    }

    @Test
    fun durableAmbiguousDeliveryWakesAtRetryDeadline() {
        val fixture = Fixture(FakeStore(queued("durable")))
        fixture.runtime.onStartupReady()
        fixture.rpc.reply(RpcOutcome.Failure(RpcFailure.Timeout))

        assertEquals(1, fixture.rpc.invocations)
        assertTrue(fixture.scheduler.tasks.containsKey("durable"))

        fixture.scheduler.fire("durable")
        assertEquals(2, fixture.rpc.invocations)
    }

    @Test
    fun durableStateFlowAndActionsReflectCoordinatorRecords() {
        val fixture = Fixture(FakeStore(queued("visible")))
        fixture.availability.durable = false

        fixture.runtime.onStartupReady()
        assertEquals(listOf("visible"), fixture.runtime.state.value.map { it.origin })
        fixture.rpc.reply(RpcOutcome.Failure(RpcFailure.Timeout))
        assertTrue(
            fixture.runtime.state.value.single().deliveryState is OutboxDeliveryState.Ambiguous,
        )

        assertTrue(fixture.runtime.retry("visible"))
        assertEquals("visible", fixture.runtime.state.value.single().origin)
        fixture.runtime.dismiss("visible")
        assertTrue(fixture.runtime.state.value.isNotEmpty())
    }

    private class Fixture(store: FakeStore) {
        val rpc = FakeRpc()
        val availability = Availability()
        private val clock = FakeClock()
        val scheduler = FakeScheduler(clock)
        private var nextId = 1
        val runtime = OutboxRuntime(
            store = store,
            attachmentStager = FakeStager,
            imageMaterializer = OutboxImageMaterializer { OutboxImageMaterialization.Success(emptyList()) },
            clients = OutboxClientLookup { SwitchboardRemoteClient(it, rpc) },
            capabilities = availability,
            clock = clock,
            scheduler = scheduler,
            ids = OutboxIdSource { "new-${nextId++}" },
            observer = SilentObserver,
        )
    }

    private class Availability : OutboxCapabilityLookup {
        var ready = true
        var durable = true
        var generation = 1L

        override fun lookup(turn: QueuedTurn) = OutboxConnectionAvailability(
            generation = generation,
            readiness = if (ready) DeliveryReadiness.Ready else DeliveryReadiness.Offline,
            capabilities = if (durable) setOf(DURABLE_TURN_ORIGIN_CAPABILITY) else emptySet(),
        )
    }

    private class FakeRpc : RemoteRpc {
        override var scope: TransportScope? = TransportScope("phone", "mac-a", 1)
        var synchronousOutcome: RpcOutcome? = null
        var invocations = 0
        val messages = mutableListOf<String>()
        private val callbacks = ArrayDeque<(RpcOutcome) -> Unit>()

        override fun invoke(
            expectedScope: TransportScope,
            channel: String,
            args: JsonArray,
            callback: (RpcOutcome) -> Unit,
        ): RequestSubmission {
            invocations++
            messages += (args.values[1] as app.switchboard.mobile.protocol.JsonString).value
            callbacks.addLast(callback)
            synchronousOutcome?.let(callback)
            return RequestSubmission.Accepted(invocations.toLong(), expectedScope)
        }

        override fun onRuntimeEvent(listener: (TransportScope, RuntimeEventPayload) -> Unit) = Cancelable {}

        fun reply(outcome: RpcOutcome) = callbacks.removeAt(0)(outcome)
    }

    private class FakeStore(vararg initial: QueuedTurn) : OutboxStore {
        val rows = initial.associateByTo(linkedMapOf(), QueuedTurn::origin)
        var loads = 0
        var failDelete = false

        override fun insert(turn: QueuedTurn): OutboxStorageResult {
            if (rows.putIfAbsent(turn.origin, turn) != null) return OutboxStorageResult.Failure("duplicate")
            return OutboxStorageResult.Success
        }

        override fun update(turn: QueuedTurn): OutboxStorageResult {
            rows[turn.origin] = turn
            return OutboxStorageResult.Success
        }

        override fun replace(turn: QueuedTurn): OutboxStorageResult = update(turn)

        override fun delete(origin: String): OutboxStorageResult {
            if (failDelete) return OutboxStorageResult.Failure("cleanup failed")
            rows.remove(origin)
            return OutboxStorageResult.Success
        }

        override fun load(): OutboxLoadResult {
            loads++
            return OutboxLoadResult.Success(rows.values.toList())
        }
    }

    private object FakeStager : AttachmentStager {
        override fun stage(attachments: List<AttachmentDraft>) = AttachmentStageResult.Success(
            attachments.map { StagedAttachment(it.sourceUri, it.mimeType) },
        )

        override fun discard(attachments: List<StagedAttachment>) = Unit
    }

    private class FakeClock : OutboxClock {
        var now = 1_000L
        override fun nowMs() = now
    }

    private class FakeScheduler(private val clock: FakeClock) : OutboxRetryScheduler {
        data class Task(val delayMs: Long, val callback: () -> Unit)
        val tasks = mutableMapOf<String, Task>()
        override fun schedule(origin: String, delayMs: Long, callback: () -> Unit) {
            tasks[origin] = Task(delayMs, callback)
        }
        override fun cancel(origin: String) {
            tasks.remove(origin)
        }
        fun fire(origin: String) {
            val task = requireNotNull(tasks.remove(origin))
            clock.now += task.delayMs
            task.callback()
        }
    }

    private object SilentObserver : OutboxObserver {
        override fun onDurablyEnqueued(turn: QueuedTurn) = Unit
        override fun onAcknowledged(turn: QueuedTurn) = Unit
        override fun onTerminal(turn: QueuedTurn, reason: String) = Unit
        override fun onAmbiguous(turn: QueuedTurn, reason: String) = Unit
        override fun onStorageBlocked(turn: QueuedTurn, reason: String) = Unit
        override fun onHydrationFailure(reason: String) = Unit
    }

    private fun queued(origin: String) = QueuedTurn(
        connectionId = "mac-a",
        threadId = "thread-a",
        origin = origin,
        bubbleId = "remote_$origin",
        text = origin,
        attachments = emptyList(),
        runtimeMode = "sandbox",
        createdAtMs = 1,
        attempts = 0,
        nextAttemptAtMs = 0,
        deliveryState = OutboxDeliveryState.Pending,
    )

    private fun draft(threadId: String, text: String) = OutgoingTurnDraft(
        connectionId = "mac-a",
        threadId = threadId,
        text = text,
        attachments = emptyList(),
        runtimeMode = "sandbox",
        createdAtMs = 1,
    )
}
