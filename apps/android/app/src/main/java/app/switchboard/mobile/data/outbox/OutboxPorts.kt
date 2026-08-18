package app.switchboard.mobile.data.outbox

import app.switchboard.mobile.domain.outbox.AttachmentDraft
import app.switchboard.mobile.domain.outbox.DeliveryGate
import app.switchboard.mobile.domain.outbox.QueuedTurn
import app.switchboard.mobile.domain.outbox.SendOutcome
import app.switchboard.mobile.domain.outbox.StagedAttachment

sealed interface OutboxStorageResult {
    data object Success : OutboxStorageResult
    data class Failure(val reason: String) : OutboxStorageResult
}

sealed interface OutboxLoadResult {
    data class Success(val turns: List<QueuedTurn>) : OutboxLoadResult
    data class Failure(val reason: String) : OutboxLoadResult
}

interface OutboxStore {
    fun insert(turn: QueuedTurn): OutboxStorageResult
    fun update(turn: QueuedTurn): OutboxStorageResult
    fun replace(turn: QueuedTurn): OutboxStorageResult
    fun delete(origin: String): OutboxStorageResult
    fun load(): OutboxLoadResult
}

sealed interface AttachmentStageResult {
    data class Success(val attachments: List<StagedAttachment>) : AttachmentStageResult
    data class Failure(val reason: String) : AttachmentStageResult
}

interface AttachmentStager {
    fun stage(attachments: List<AttachmentDraft>): AttachmentStageResult
    fun discard(attachments: List<StagedAttachment>)
}

fun interface OutboxSender {
    fun send(turn: QueuedTurn, callback: (SendOutcome) -> Unit)
}

fun interface OutboxEnvironment {
    fun gate(turn: QueuedTurn): DeliveryGate
}

fun interface OutboxClock {
    fun nowMs(): Long
}

interface OutboxRetryScheduler {
    fun schedule(origin: String, delayMs: Long, callback: () -> Unit)
    fun cancel(origin: String)
}

fun interface OutboxIdSource {
    fun nextOrigin(): String
}

interface OutboxObserver {
    fun onDurablyEnqueued(turn: QueuedTurn)
    fun onAcknowledged(turn: QueuedTurn)
    fun onTerminal(turn: QueuedTurn, reason: String)
    fun onAmbiguous(turn: QueuedTurn, reason: String)
    fun onStorageBlocked(turn: QueuedTurn, reason: String)
    fun onHydrationFailure(reason: String)
}
