package app.switchboard.mobile.data.outbox

import app.switchboard.mobile.domain.outbox.DeliveryGate
import app.switchboard.mobile.domain.outbox.DeliveryReadiness
import app.switchboard.mobile.domain.outbox.EnqueueResult
import app.switchboard.mobile.domain.outbox.OutgoingTurnDraft
import app.switchboard.mobile.domain.outbox.QueuedTurn
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

class OutboxRuntime(
    store: OutboxStore,
    attachmentStager: AttachmentStager,
    imageMaterializer: OutboxImageMaterializer,
    clients: OutboxClientLookup,
    private val capabilities: OutboxCapabilityLookup,
    clock: OutboxClock,
    scheduler: OutboxRetryScheduler,
    ids: OutboxIdSource,
    observer: OutboxObserver,
) {
    private val mutableState = MutableStateFlow<List<QueuedTurn>>(emptyList())
    val state = mutableState.asStateFlow()
    private val coordinator: OutboxCoordinator
    private var hydrated = false

    init {
        val forwardingObserver = object : OutboxObserver {
            override fun onDurablyEnqueued(turn: QueuedTurn) {
                observer.onDurablyEnqueued(turn)
                publish()
            }

            override fun onAcknowledged(turn: QueuedTurn) {
                observer.onAcknowledged(turn)
                mutableState.value = coordinator.records().filterNot { it.origin == turn.origin }
            }

            override fun onTerminal(turn: QueuedTurn, reason: String) {
                observer.onTerminal(turn, reason)
                publish()
            }

            override fun onAmbiguous(turn: QueuedTurn, reason: String) {
                observer.onAmbiguous(turn, reason)
                publish()
            }

            override fun onStorageBlocked(turn: QueuedTurn, reason: String) {
                observer.onStorageBlocked(turn, reason)
                publish()
            }

            override fun onHydrationFailure(reason: String) = observer.onHydrationFailure(reason)
        }
        coordinator = OutboxCoordinator(
            store = store,
            attachmentStager = attachmentStager,
            sender = OutboxRemoteSender(clients, capabilities, imageMaterializer),
            environment = OutboxEnvironment(::deliveryGate),
            clock = clock,
            scheduler = scheduler,
            ids = ids,
            observer = forwardingObserver,
        )
    }

    @Synchronized
    fun onStartupReady() {
        if (hydrated) return
        hydrated = true
        coordinator.hydrate()
        publish()
    }

    @Synchronized
    fun onFleetChanged() {
        if (hydrated) coordinator.pump()
    }

    @Synchronized
    fun enqueue(draft: OutgoingTurnDraft): EnqueueResult {
        if (!hydrated) return EnqueueResult.StorageFailure("Outbox is still loading")
        return coordinator.enqueue(draft)
    }

    fun records(): List<QueuedTurn> = coordinator.records()

    fun setEditing(origin: String, editing: Boolean) = coordinator.setEditing(origin, editing)

    fun beginEdit(origin: String): QueuedTurn? = coordinator.beginEdit(origin)

    fun replace(origin: String, draft: OutgoingTurnDraft): EnqueueResult =
        if (!hydrated) EnqueueResult.StorageFailure("Outbox is still loading")
        else coordinator.replace(origin, draft).also { publish() }

    fun retry(origin: String): Boolean = coordinator.retry(origin).also { publish() }

    fun abandonResolved(origin: String): Boolean = coordinator.abandonResolved(origin).also { publish() }

    fun dismiss(origin: String) {
        coordinator.dismiss(origin)
        publish()
    }

    private fun publish() {
        mutableState.value = coordinator.records()
    }

    private fun deliveryGate(turn: QueuedTurn): DeliveryGate {
        val availability = capabilities.lookup(turn)
            ?: return DeliveryGate(DeliveryReadiness.Offline, durableOriginDedupe = false)
        return DeliveryGate(
            readiness = availability.readiness,
            durableOriginDedupe = availability.durableOriginDedupe,
        )
    }
}
