package app.switchboard.mobile.data.outbox

import app.switchboard.mobile.domain.outbox.DeliveryGate
import app.switchboard.mobile.domain.outbox.DeliveryReadiness
import app.switchboard.mobile.domain.outbox.EnqueueResult
import app.switchboard.mobile.domain.outbox.OutgoingTurnDraft
import app.switchboard.mobile.domain.outbox.QueuedTurn

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
    private val coordinator = OutboxCoordinator(
        store = store,
        attachmentStager = attachmentStager,
        sender = OutboxRemoteSender(clients, capabilities, imageMaterializer),
        environment = OutboxEnvironment(::deliveryGate),
        clock = clock,
        scheduler = scheduler,
        ids = ids,
        observer = observer,
    )
    private var hydrated = false

    @Synchronized
    fun onStartupReady() {
        if (hydrated) return
        hydrated = true
        coordinator.hydrate()
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

    fun dismiss(origin: String) = coordinator.dismiss(origin)

    private fun deliveryGate(turn: QueuedTurn): DeliveryGate {
        val availability = capabilities.lookup(turn)
            ?: return DeliveryGate(DeliveryReadiness.Offline, durableOriginDedupe = false)
        return DeliveryGate(
            readiness = availability.readiness,
            durableOriginDedupe = availability.durableOriginDedupe,
        )
    }
}
