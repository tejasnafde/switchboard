package app.switchboard.mobile.data.outbox

import app.switchboard.mobile.data.remote.SwitchboardRemoteClient
import app.switchboard.mobile.domain.outbox.DeliveryReadiness
import app.switchboard.mobile.domain.outbox.QueuedTurn
import app.switchboard.mobile.domain.outbox.SendOutcome
import app.switchboard.mobile.domain.outbox.SendResponseDecoder
import app.switchboard.mobile.domain.remote.CommandBody
import app.switchboard.mobile.domain.remote.ImageInput
import app.switchboard.mobile.domain.remote.RemoteOutcome
import app.switchboard.mobile.domain.remote.RemoteResponse
import app.switchboard.mobile.domain.remote.RuntimeMode
import app.switchboard.mobile.platform.protocol.RequestSubmission
import app.switchboard.mobile.platform.protocol.RpcFailure

const val DURABLE_TURN_ORIGIN_CAPABILITY = "durable_turn_origin"

sealed interface OutboxImageMaterialization {
    data class Success(val images: List<ImageInput>) : OutboxImageMaterialization

    data class Failure(val reason: String) : OutboxImageMaterialization
}

fun interface OutboxImageMaterializer {
    fun materialize(turn: QueuedTurn): OutboxImageMaterialization
}

fun interface OutboxClientLookup {
    fun client(connectionId: String): SwitchboardRemoteClient?
}

data class OutboxConnectionAvailability(
    val generation: Long,
    val readiness: DeliveryReadiness,
    val capabilities: Set<String>,
) {
    val durableOriginDedupe: Boolean
        get() = DURABLE_TURN_ORIGIN_CAPABILITY in capabilities
}

fun interface OutboxCapabilityLookup {
    fun lookup(turn: QueuedTurn): OutboxConnectionAvailability?
}

class OutboxRemoteSender(
    private val clients: OutboxClientLookup,
    private val capabilities: OutboxCapabilityLookup,
    private val images: OutboxImageMaterializer,
) : OutboxSender {
    override fun send(turn: QueuedTurn, callback: (SendOutcome) -> Unit) {
        val runtimeMode = when (val wire = turn.runtimeMode) {
            null -> null
            else -> RuntimeMode.entries.firstOrNull { it.wire == wire }
                ?: return callback(SendOutcome.Permanent("Unsupported runtime mode"))
        }
        val materialized = when (val result = images.materialize(turn)) {
            is OutboxImageMaterialization.Failure -> {
                callback(SendOutcome.Permanent(result.reason))
                return
            }
            is OutboxImageMaterialization.Success -> result.images
        }
        val client = clients.client(turn.connectionId)
            ?: return callback(SendOutcome.Retryable("Connection is unavailable"))
        val availability = capabilities.lookup(turn)
        if (availability?.readiness != DeliveryReadiness.Ready) {
            callback(SendOutcome.Retryable("Connection is not ready"))
            return
        }

        val completion = SubmissionAwareCompletion(
            classifyResponse = { response -> classifyResponse(turn, response) },
            callback = callback,
        )
        try {
            val submission = client.sendTurn(
                threadId = turn.threadId,
                message = turn.text,
                runtimeMode = runtimeMode,
                images = materialized.takeIf { it.isNotEmpty() },
                origin = turn.origin,
                callback = completion::response,
            )
            completion.submitted(submission)
        } catch (_: RuntimeException) {
            completion.failedBeforeSubmission(SendOutcome.TransportAmbiguous("Send completion is unknown"))
        }
    }

    private fun classifyResponse(
        turn: QueuedTurn,
        response: RemoteResponse<CommandBody>,
    ): SendOutcome {
        val current = capabilities.lookup(turn)
        if (
            response.key.connectionId != turn.connectionId ||
            current == null ||
            response.key.generation != current.generation
        ) {
            return SendOutcome.TransportAmbiguous("Connection changed while sending")
        }
        return when (val outcome = response.outcome) {
            is RemoteOutcome.Success -> SendResponseDecoder.decode(outcome.value.body)
            is RemoteOutcome.Failure -> deterministicRejection(outcome.message)
                ?.let(SendOutcome::Permanent)
                ?: SendOutcome.TransportAmbiguous(outcome.message)
        }
    }

}

private fun deterministicRejection(message: String): String? {
    if (ORIGIN_CONFLICT_MESSAGE in message) return ORIGIN_CONFLICT_RECOVERY
    return IMAGE_REJECTION_MESSAGES.firstOrNull(message::contains)
}

private const val ORIGIN_CONFLICT_MESSAGE =
    "turn origin was already used with a different payload"
private const val ORIGIN_CONFLICT_RECOVERY =
    "This turn's retry identity was already used with different text or images. Send the edit as a new message."

private val IMAGE_REJECTION_MESSAGES = listOf(
    "Images must be PNG, JPEG, WebP, or GIF data URLs",
    "Image MIME type does not match its data URL",
    "Images exceed the 3 MiB synchronization limit",
)

private class SubmissionAwareCompletion(
    private val classifyResponse: (RemoteResponse<CommandBody>) -> SendOutcome,
    private val callback: (SendOutcome) -> Unit,
) {
    private var submission: RequestSubmission? = null
    private var bufferedResponse: RemoteResponse<CommandBody>? = null
    private var completed = false

    fun response(response: RemoteResponse<CommandBody>) {
        val outcome = synchronized(this) {
            if (completed) return
            val knownSubmission = submission
            if (knownSubmission == null) {
                if (bufferedResponse == null) bufferedResponse = response
                null
            } else {
                completed = true
                classify(knownSubmission, response)
            }
        }
        outcome?.let(callback)
    }

    fun submitted(value: RequestSubmission) {
        val outcome = synchronized(this) {
            if (completed) return
            submission = value
            when (value) {
                is RequestSubmission.Rejected -> {
                    completed = true
                    classifyRejection(value.reason)
                }
                is RequestSubmission.Accepted -> bufferedResponse?.let { response ->
                    completed = true
                    classifyResponse(response)
                }
            }
        }
        outcome?.let(callback)
    }

    fun failedBeforeSubmission(outcome: SendOutcome) {
        val shouldDeliver = synchronized(this) {
            if (completed) false else {
                completed = true
                true
            }
        }
        if (shouldDeliver) callback(outcome)
    }

    private fun classify(
        submission: RequestSubmission,
        response: RemoteResponse<CommandBody>,
    ): SendOutcome = when (submission) {
        is RequestSubmission.Accepted -> classifyResponse(response)
        is RequestSubmission.Rejected -> classifyRejection(submission.reason)
    }

    private fun classifyRejection(reason: RpcFailure): SendOutcome = when (reason) {
        RpcFailure.NotReady,
        RpcFailure.CapacityExceeded,
        RpcFailure.ConnectionReplaced,
        -> SendOutcome.Retryable(reason.toString())
        RpcFailure.Timeout,
        RpcFailure.SendFailed,
        RpcFailure.ServiceDestroyed,
        is RpcFailure.ConnectionLost,
        -> SendOutcome.TransportAmbiguous(reason.toString())
        is RpcFailure.Remote -> deterministicRejection(reason.error)
            ?.let(SendOutcome::Permanent)
            ?: SendOutcome.TransportAmbiguous(reason.error)
    }
}
