package app.switchboard.mobile.domain.outbox

import app.switchboard.mobile.protocol.JsonObject

data class AttachmentDraft(
    val sourceUri: String,
    val mimeType: String?,
)

data class StagedAttachment(
    val privateUri: String,
    val mimeType: String?,
)

data class OutboxIdentity(
    val origin: String,
) {
    val bubbleId: String = "remote_$origin"
}

data class OutgoingTurnDraft(
    val connectionId: String,
    val threadId: String,
    val text: String,
    val attachments: List<AttachmentDraft>,
    val runtimeMode: String?,
    val createdAtMs: Long,
)

data class SendReceipt(
    val legacy: Boolean,
    val duplicate: Boolean,
    val raw: JsonObject?,
) {
    companion object {
        fun legacy() = SendReceipt(legacy = true, duplicate = false, raw = null)
    }
}

sealed interface OutboxDeliveryState {
    val label: String

    data object Pending : OutboxDeliveryState {
        override val label = "pending"
    }

    data class Acknowledged(val receipt: SendReceipt) : OutboxDeliveryState {
        override val label = "acknowledged"
    }

    data class Terminal(val reason: String) : OutboxDeliveryState {
        override val label = "terminal"
    }

    data class Ambiguous(val reason: String) : OutboxDeliveryState {
        override val label = "ambiguous"
    }
}

data class QueuedTurn(
    val connectionId: String,
    val threadId: String,
    val origin: String,
    val bubbleId: String,
    val text: String,
    val attachments: List<StagedAttachment>,
    val runtimeMode: String?,
    val createdAtMs: Long,
    val attempts: Int,
    val nextAttemptAtMs: Long,
    val deliveryState: OutboxDeliveryState,
    val legacyRawJson: String? = null,
)

enum class DeliveryReadiness {
    Ready,
    Offline,
    Busy,
    Editing,
    MissingThread,
}

data class DeliveryGate(
    val readiness: DeliveryReadiness,
    val durableOriginDedupe: Boolean,
)

sealed interface SendOutcome {
    data class Accepted(val receipt: SendReceipt) : SendOutcome
    data class Pending(val reason: String?, val raw: JsonObject? = null) : SendOutcome
    data class Retryable(val reason: String) : SendOutcome
    data class Permanent(val reason: String) : SendOutcome
    data class Ambiguous(val reason: String, val raw: JsonObject? = null) : SendOutcome
    data class TransportAmbiguous(val reason: String) : SendOutcome
}

sealed interface EnqueueResult {
    data class Durable(val turn: QueuedTurn) : EnqueueResult
    data class AttachmentFailure(val reason: String) : EnqueueResult
    data class StorageFailure(val reason: String) : EnqueueResult
}

object OutboxRetry {
    const val MaxDelayMs = 16_000L

    fun delayMs(attempts: Int): Long {
        val exponent = (attempts.coerceAtLeast(1) - 1).coerceAtMost(4)
        return (1_000L shl exponent).coerceAtMost(MaxDelayMs)
    }
}

sealed interface OutboxOperationResult<out T> {
    data class Success<T>(val value: T) : OutboxOperationResult<T>
    data class Failure(val message: String) : OutboxOperationResult<Nothing>
}

data class OutboxFollowUpResult<C, F>(
    val command: OutboxOperationResult<C>,
    val followUp: OutboxOperationResult<F>?,
)

object OutboxFollowUpPolicy {
    fun <C, F> afterCommand(
        command: OutboxOperationResult<C>,
        followUp: () -> OutboxOperationResult<F>,
    ): OutboxFollowUpResult<C, F> =
        if (command is OutboxOperationResult.Failure) {
            OutboxFollowUpResult(command, null)
        } else {
            OutboxFollowUpResult(command, followUp())
        }
}
