package app.switchboard.mobile.data.outbox

import app.switchboard.mobile.domain.outbox.DeliveryReadiness
import app.switchboard.mobile.domain.outbox.EnqueueResult
import app.switchboard.mobile.domain.outbox.OutboxDeliveryState
import app.switchboard.mobile.domain.outbox.OutboxIdentity
import app.switchboard.mobile.domain.outbox.OutboxRetry
import app.switchboard.mobile.domain.outbox.OutgoingTurnDraft
import app.switchboard.mobile.domain.outbox.QueuedTurn
import app.switchboard.mobile.domain.outbox.SendOutcome

class OutboxCoordinator(
    private val store: OutboxStore,
    private val attachmentStager: AttachmentStager,
    private val sender: OutboxSender,
    private val environment: OutboxEnvironment,
    private val clock: OutboxClock,
    private val scheduler: OutboxRetryScheduler,
    private val ids: OutboxIdSource,
    private val observer: OutboxObserver,
) {
    private data class ThreadQueueKey(
        val connectionId: String,
        val threadId: String,
    )

    private val records = linkedMapOf<String, QueuedTurn>()
    private val inFlightThreads = mutableSetOf<ThreadQueueKey>()
    private val inFlightOrigins = mutableSetOf<String>()
    private val attemptTokens = mutableMapOf<String, Long>()
    private val durableDedupeByOrigin = mutableMapOf<String, Boolean>()
    private val blockedThreads = mutableSetOf<ThreadQueueKey>()
    private val editingOrigins = mutableSetOf<String>()
    private val scheduledAt = mutableMapOf<String, Long>()
    private var pumping = false
    private var pumpAgain = false
    private var nextAttemptToken = 0L

    @Synchronized
    fun records(): List<QueuedTurn> = records.values.sortedWith(turnOrder)

    @Synchronized
    fun enqueue(draft: OutgoingTurnDraft): EnqueueResult {
        val staged = when (val result = attachmentStager.stage(draft.attachments)) {
            is AttachmentStageResult.Failure -> return EnqueueResult.AttachmentFailure(result.reason)
            is AttachmentStageResult.Success -> result.attachments
        }
        val identity = OutboxIdentity(ids.nextOrigin())
        val turn = QueuedTurn(
            connectionId = draft.connectionId,
            threadId = draft.threadId,
            origin = identity.origin,
            bubbleId = identity.bubbleId,
            text = draft.text,
            attachments = staged,
            runtimeMode = draft.runtimeMode,
            createdAtMs = draft.createdAtMs,
            attempts = 0,
            nextAttemptAtMs = 0,
            deliveryState = OutboxDeliveryState.Pending,
        )
        when (val persisted = store.insert(turn)) {
            is OutboxStorageResult.Failure -> {
                attachmentStager.discard(staged)
                return EnqueueResult.StorageFailure(persisted.reason)
            }
            OutboxStorageResult.Success -> Unit
        }
        records[turn.origin] = turn
        observer.onDurablyEnqueued(turn)
        requestPump()
        return EnqueueResult.Durable(turn)
    }

    @Synchronized
    fun hydrate() {
        val loaded = when (val result = store.load()) {
            is OutboxLoadResult.Failure -> {
                observer.onHydrationFailure(result.reason)
                return
            }
            is OutboxLoadResult.Success -> result.turns
        }
        loaded.sortedWith(turnOrder).forEach { turn ->
            records.putIfAbsent(turn.origin, turn)
            when (val state = turn.deliveryState) {
                OutboxDeliveryState.Pending -> Unit
                is OutboxDeliveryState.Acknowledged -> {
                    observer.onAcknowledged(turn)
                    cleanupAcknowledged(turn)
                }
                is OutboxDeliveryState.Terminal -> observer.onTerminal(turn, state.reason)
                is OutboxDeliveryState.Ambiguous -> observer.onAmbiguous(turn, state.reason)
            }
        }
        requestPump()
    }

    @Synchronized
    fun setEditing(origin: String, editing: Boolean) {
        if (editing) editingOrigins += origin else editingOrigins -= origin
        if (!editing) requestPump()
    }

    @Synchronized
    fun beginEdit(origin: String): QueuedTurn? {
        val turn = records[origin] ?: return null
        editingOrigins += origin
        invalidateAttempt(turn)
        scheduler.cancel(origin)
        scheduledAt.remove(origin)
        return turn
    }

    @Synchronized
    fun replace(origin: String, draft: OutgoingTurnDraft): EnqueueResult {
        val before = records[origin]
            ?: return EnqueueResult.StorageFailure("Queued turn no longer exists")
        if (draft.connectionId != before.connectionId || draft.threadId != before.threadId) {
            return EnqueueResult.StorageFailure("Queued turn scope cannot change")
        }
        val staged = when (val result = attachmentStager.stage(draft.attachments)) {
            is AttachmentStageResult.Failure -> return EnqueueResult.AttachmentFailure(result.reason)
            is AttachmentStageResult.Success -> result.attachments
        }
        val replacement = before.copy(
            text = draft.text,
            attachments = staged,
            runtimeMode = draft.runtimeMode,
            attempts = 0,
            nextAttemptAtMs = 0,
            deliveryState = OutboxDeliveryState.Pending,
            legacyRawJson = null,
        )
        return when (val persisted = store.replace(replacement)) {
            OutboxStorageResult.Success -> {
                records[origin] = replacement
                editingOrigins -= origin
                blockedThreads -= before.threadKey()
                attachmentStager.discard(before.attachments)
                requestPump()
                EnqueueResult.Durable(replacement)
            }
            is OutboxStorageResult.Failure -> {
                attachmentStager.discard(staged)
                EnqueueResult.StorageFailure(persisted.reason)
            }
        }
    }

    @Synchronized
    fun retry(origin: String): Boolean {
        val before = records[origin] ?: return false
        if (
            before.deliveryState !is OutboxDeliveryState.Ambiguous &&
            before.deliveryState !is OutboxDeliveryState.Terminal
        ) return false
        val pending = before.copy(
            attempts = 0,
            nextAttemptAtMs = 0,
            deliveryState = OutboxDeliveryState.Pending,
        )
        if (!persistTransition(before, pending)) return false
        editingOrigins -= origin
        blockedThreads -= before.threadKey()
        requestPump()
        return true
    }

    @Synchronized
    fun dismiss(origin: String) {
        val turn = records[origin] ?: return
        if (turn.deliveryState is OutboxDeliveryState.Pending) return
        when (store.delete(origin)) {
            is OutboxStorageResult.Failure -> return
            OutboxStorageResult.Success -> {
                invalidateAttempt(turn)
                records.remove(origin)
                blockedThreads -= turn.threadKey()
                attachmentStager.discard(turn.attachments)
                scheduler.cancel(origin)
                scheduledAt.remove(origin)
                requestPump()
            }
        }
    }

    @Synchronized
    fun pump() {
        if (pumping) {
            pumpAgain = true
            return
        }
        pumping = true
        try {
            do {
                pumpAgain = false
                headsByThread().forEach(::consider)
            } while (pumpAgain)
        } finally {
            pumping = false
        }
    }

    @Synchronized
    private fun requestPump() {
        if (pumping) pumpAgain = true else pump()
    }

    private fun headsByThread(): List<QueuedTurn> {
        val ambiguousThreads = records.values
            .filter { it.deliveryState is OutboxDeliveryState.Ambiguous }
            .mapTo(mutableSetOf()) { it.threadKey() }
        val heads = linkedMapOf<ThreadQueueKey, QueuedTurn>()
        records.values.sortedWith(turnOrder).forEach { turn ->
            if (turn.deliveryState !is OutboxDeliveryState.Pending) return@forEach
            val key = turn.threadKey()
            if (key in blockedThreads || key in ambiguousThreads || key in inFlightThreads) return@forEach
            heads.putIfAbsent(key, turn)
        }
        return heads.values.toList()
    }

    private fun consider(turn: QueuedTurn) {
        if (turn.origin in editingOrigins) return
        val now = clock.nowMs()
        if (turn.nextAttemptAtMs > now) {
            schedule(turn)
            return
        }
        val gate = environment.gate(turn)
        when (gate.readiness) {
            DeliveryReadiness.Ready -> startSend(turn, gate.durableOriginDedupe)
            DeliveryReadiness.MissingThread -> persistTerminal(turn, "Thread no longer exists")
            DeliveryReadiness.Offline,
            DeliveryReadiness.Busy,
            DeliveryReadiness.Editing,
            -> Unit
        }
    }

    private fun startSend(turn: QueuedTurn, durableDedupe: Boolean) {
        val key = turn.threadKey()
        if (!inFlightThreads.add(key) || !inFlightOrigins.add(turn.origin)) return
        durableDedupeByOrigin[turn.origin] = durableDedupe
        val token = ++nextAttemptToken
        attemptTokens[turn.origin] = token
        try {
            sender.send(turn) { outcome -> complete(turn.origin, token, outcome) }
        } catch (error: RuntimeException) {
            complete(turn.origin, token, SendOutcome.TransportAmbiguous(error.message ?: "Sender failed"))
        }
    }

    @Synchronized
    private fun complete(origin: String, token: Long, outcome: SendOutcome) {
        if (attemptTokens[origin] != token) return
        attemptTokens.remove(origin)
        if (!inFlightOrigins.remove(origin)) return
        val turn = records[origin] ?: return
        inFlightThreads -= turn.threadKey()
        val durableDedupe = durableDedupeByOrigin.remove(origin) == true
        when (outcome) {
            is SendOutcome.Accepted -> persistAcknowledged(turn, outcome)
            is SendOutcome.Pending -> persistRetry(turn)
            is SendOutcome.Retryable -> persistRetry(turn)
            is SendOutcome.Permanent -> persistTerminal(turn, outcome.reason)
            is SendOutcome.Ambiguous -> persistAmbiguous(turn, outcome.reason)
            is SendOutcome.TransportAmbiguous -> {
                if (durableDedupe) persistRetry(turn) else persistAmbiguous(turn, outcome.reason)
            }
        }
        requestPump()
    }

    private fun persistAcknowledged(turn: QueuedTurn, outcome: SendOutcome.Accepted) {
        val acknowledged = turn.copy(
            nextAttemptAtMs = 0,
            deliveryState = OutboxDeliveryState.Acknowledged(outcome.receipt),
        )
        if (!persistTransition(turn, acknowledged)) return
        observer.onAcknowledged(acknowledged)
        cleanupAcknowledged(acknowledged)
    }

    private fun cleanupAcknowledged(turn: QueuedTurn) {
        scheduler.cancel(turn.origin)
        scheduledAt.remove(turn.origin)
        when (store.delete(turn.origin)) {
            is OutboxStorageResult.Failure -> Unit
            OutboxStorageResult.Success -> {
                attemptTokens.remove(turn.origin)
                records.remove(turn.origin)
                attachmentStager.discard(turn.attachments)
            }
        }
    }

    private fun persistRetry(turn: QueuedTurn) {
        val attempts = turn.attempts + 1
        val updated = turn.copy(
            attempts = attempts,
            nextAttemptAtMs = clock.nowMs() + OutboxRetry.delayMs(attempts),
            deliveryState = OutboxDeliveryState.Pending,
        )
        if (!persistTransition(turn, updated)) return
        schedule(updated)
    }

    private fun persistTerminal(turn: QueuedTurn, reason: String) {
        val terminal = turn.copy(
            nextAttemptAtMs = 0,
            deliveryState = OutboxDeliveryState.Terminal(reason),
        )
        if (!persistTransition(turn, terminal)) return
        scheduler.cancel(turn.origin)
        scheduledAt.remove(turn.origin)
        observer.onTerminal(terminal, reason)
    }

    private fun persistAmbiguous(turn: QueuedTurn, reason: String) {
        val ambiguous = turn.copy(
            nextAttemptAtMs = 0,
            deliveryState = OutboxDeliveryState.Ambiguous(reason),
        )
        if (!persistTransition(turn, ambiguous)) return
        scheduler.cancel(turn.origin)
        scheduledAt.remove(turn.origin)
        observer.onAmbiguous(ambiguous, reason)
    }

    private fun persistTransition(before: QueuedTurn, after: QueuedTurn): Boolean =
        when (val result = store.update(after)) {
            OutboxStorageResult.Success -> {
                records[after.origin] = after
                true
            }
            is OutboxStorageResult.Failure -> {
                blockedThreads += before.threadKey()
                observer.onStorageBlocked(before, result.reason)
                false
            }
        }

    private fun schedule(turn: QueuedTurn) {
        if (scheduledAt[turn.origin] == turn.nextAttemptAtMs) return
        scheduler.cancel(turn.origin)
        scheduledAt[turn.origin] = turn.nextAttemptAtMs
        val delay = (turn.nextAttemptAtMs - clock.nowMs()).coerceAtLeast(0)
        scheduler.schedule(turn.origin, delay) {
            scheduledAt.remove(turn.origin)
            requestPump()
        }
    }

    private fun QueuedTurn.threadKey() = ThreadQueueKey(connectionId, threadId)

    private fun invalidateAttempt(turn: QueuedTurn) {
        attemptTokens.remove(turn.origin)
        durableDedupeByOrigin.remove(turn.origin)
        inFlightOrigins.remove(turn.origin)
        inFlightThreads.remove(turn.threadKey())
    }

    private companion object {
        val turnOrder = compareBy<QueuedTurn> { it.createdAtMs }.thenBy { it.origin }
    }
}
