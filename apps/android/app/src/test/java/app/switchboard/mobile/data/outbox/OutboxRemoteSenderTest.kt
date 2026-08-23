package app.switchboard.mobile.data.outbox

import app.switchboard.mobile.data.remote.RemoteRpc
import app.switchboard.mobile.data.remote.SwitchboardRemoteClient
import app.switchboard.mobile.domain.outbox.OutboxDeliveryState
import app.switchboard.mobile.domain.outbox.QueuedTurn
import app.switchboard.mobile.domain.outbox.SendOutcome
import app.switchboard.mobile.domain.outbox.StagedAttachment
import app.switchboard.mobile.domain.remote.ImageInput
import app.switchboard.mobile.platform.protocol.Cancelable
import app.switchboard.mobile.platform.protocol.RequestSubmission
import app.switchboard.mobile.platform.protocol.RpcFailure
import app.switchboard.mobile.platform.protocol.RpcOutcome
import app.switchboard.mobile.platform.protocol.TransportScope
import app.switchboard.mobile.platform.outbox.OutboxPrivateFileReader
import app.switchboard.mobile.platform.outbox.PrivateFileOutboxImageMaterializer
import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.RuntimeEventPayload
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class OutboxRemoteSenderTest {
    @Test
    fun successfulCommandBodyIsDecodedAndPrivateUrisNeverReachTheRpc() {
        val rpc = FakeRpc()
        rpc.synchronousOutcome = RpcOutcome.Success(
            obj(
                "accepted" to JsonBoolean(true),
                "duplicate" to JsonBoolean(false),
                "state" to JsonString("completed"),
            ),
        )
        val outcomes = mutableListOf<SendOutcome>()
        val sender = sender(rpc)

        sender.send(turn(attachments = listOf(StagedAttachment("/private/photo", "image/png"))), outcomes::add)

        assertTrue(outcomes.single() is SendOutcome.Accepted)
        assertEquals(1, rpc.invocations)
        assertTrue(rpc.lastArgs.toString().contains("data:image/png;base64,AQID"))
        assertTrue(!rpc.lastArgs.toString().contains("/private/photo"))
    }

    @Test
    fun synchronousRejectedCallbackWaitsForSubmissionAndCompletesOnlyOnce() {
        val rpc = FakeRpc(
            submission = RequestSubmission.Rejected(RpcFailure.ConnectionReplaced),
            synchronousOutcome = RpcOutcome.Failure(RpcFailure.ConnectionReplaced),
        )
        val outcomes = mutableListOf<SendOutcome>()

        sender(rpc).send(turn(), outcomes::add)
        rpc.reply(RpcOutcome.Success(null))

        assertEquals(1, outcomes.size)
        assertTrue(outcomes.single() is SendOutcome.Retryable)
    }

    @Test
    fun asynchronousFailureAndStaleGenerationAreTransportAmbiguous() {
        val availability = MutableAvailability(generation = 4)
        val rpc = FakeRpc(scope = TransportScope("phone", "mac-a", 4))
        val outcomes = mutableListOf<SendOutcome>()
        val sender = sender(rpc, availability)

        sender.send(turn(), outcomes::add)
        rpc.reply(RpcOutcome.Failure(RpcFailure.Timeout))
        assertTrue(outcomes.single() is SendOutcome.TransportAmbiguous)

        outcomes.clear()
        sender.send(turn(origin = "origin-2"), outcomes::add)
        availability.generation = 5
        rpc.reply(RpcOutcome.Success(null))
        assertTrue(outcomes.single() is SendOutcome.TransportAmbiguous)
    }

    @Test
    fun backendImageContractRejectionIsPermanentAndActionable() {
        val rpc = FakeRpc()
        val outcomes = mutableListOf<SendOutcome>()
        sender(rpc).send(turn(), outcomes::add)

        rpc.reply(
            RpcOutcome.Failure(
                RpcFailure.Remote("Images exceed the 3 MiB synchronization limit"),
            ),
        )

        val outcome = outcomes.single() as SendOutcome.Permanent
        assertEquals("Images exceed the 3 MiB synchronization limit", outcome.reason)
    }

    @Test
    fun submissionRejectedByBackendImageContractIsPermanentAndActionable() {
        val rpc = FakeRpc(
            submission = RequestSubmission.Rejected(
                RpcFailure.Remote("Images must be PNG, JPEG, WebP, or GIF data URLs"),
            ),
        )
        val outcomes = mutableListOf<SendOutcome>()

        sender(rpc).send(turn(), outcomes::add)

        val outcome = outcomes.single() as SendOutcome.Permanent
        assertEquals("Images must be PNG, JPEG, WebP, or GIF data URLs", outcome.reason)
    }

    @Test
    fun unknownRemoteFailureRemainsTransportAmbiguous() {
        val rpc = FakeRpc()
        val outcomes = mutableListOf<SendOutcome>()
        sender(rpc).send(turn(), outcomes::add)

        rpc.reply(RpcOutcome.Failure(RpcFailure.Remote("provider failed after dispatch")))

        assertTrue(outcomes.single() is SendOutcome.TransportAmbiguous)
    }

    @Test
    fun changedPayloadOriginConflictIsPermanentAndActionable() {
        val rpc = FakeRpc()
        val outcomes = mutableListOf<SendOutcome>()
        sender(rpc).send(turn(), outcomes::add)

        rpc.reply(
            RpcOutcome.Failure(
                RpcFailure.Remote("turn origin was already used with a different payload"),
            ),
        )

        val outcome = outcomes.single() as SendOutcome.Permanent
        assertEquals(
            "This turn's retry identity was already used with different text or images. Send the edit as a new message.",
            outcome.reason,
        )
    }

    @Test
    fun materializationAndInvalidRuntimeFailuresArePermanentBeforeInvoke() {
        val rpc = FakeRpc()
        val failedMaterializer = OutboxImageMaterializer {
            OutboxImageMaterialization.Failure("Attachment is too large")
        }
        val attachmentOutcome = mutableListOf<SendOutcome>()
        sender(rpc, materializer = failedMaterializer).send(turn(), attachmentOutcome::add)
        val runtimeOutcome = mutableListOf<SendOutcome>()
        sender(rpc).send(turn(runtimeMode = "future-mode"), runtimeOutcome::add)

        assertTrue(attachmentOutcome.single() is SendOutcome.Permanent)
        assertTrue(runtimeOutcome.single() is SendOutcome.Permanent)
        assertEquals(0, rpc.invocations)
    }

    @Test
    fun imageOnlyLegacyRowSendsItsOriginalDataUrl() {
        val rpc = FakeRpc(synchronousOutcome = RpcOutcome.Success(null))
        val outcomes = mutableListOf<SendOutcome>()
        val raw =
            """{"messageId":"legacy","images":[{"url":"data:image/png;base64,AQID","mimeType":"image/png"}]}"""
        val materializer = PrivateFileOutboxImageMaterializer(
            OutboxPrivateFileReader { error("legacy image must not read a private file") },
        )

        sender(rpc, materializer = materializer)
            .send(turn(origin = "legacy", legacyRawJson = raw), outcomes::add)

        assertTrue(outcomes.single() is SendOutcome.Accepted)
        assertEquals(1, rpc.invocations)
        assertTrue(rpc.lastArgs.toString().contains("data:image/png;base64,AQID"))
    }

    @Test
    fun malformedLegacyImagePayloadIsPermanentAndNeverInvokesRpc() {
        val rpc = FakeRpc()
        val outcomes = mutableListOf<SendOutcome>()
        val materializer = PrivateFileOutboxImageMaterializer(
            OutboxPrivateFileReader { error("no staged files expected") },
        )

        sender(rpc, materializer = materializer).send(
            turn(origin = "legacy", legacyRawJson = """{"images":[{"url":"not-a-data-url"}]}"""),
            outcomes::add,
        )

        assertTrue(outcomes.single() is SendOutcome.Permanent)
        assertEquals(0, rpc.invocations)
    }

    private fun sender(
        rpc: FakeRpc,
        availability: MutableAvailability = MutableAvailability(rpc.scope!!.generation),
        materializer: OutboxImageMaterializer = OutboxImageMaterializer {
            OutboxImageMaterialization.Success(listOf(ImageInput("data:image/png;base64,AQID", "image/png")))
        },
    ) = OutboxRemoteSender(
        clients = OutboxClientLookup { SwitchboardRemoteClient(it, rpc) },
        capabilities = availability,
        images = materializer,
    )

    private fun turn(
        origin: String = "origin-1",
        runtimeMode: String? = "sandbox",
        attachments: List<StagedAttachment> = emptyList(),
        legacyRawJson: String? = null,
    ) = QueuedTurn(
        connectionId = "mac-a",
        threadId = "thread-a",
        origin = origin,
        bubbleId = "remote_$origin",
        text = "hello",
        attachments = attachments,
        runtimeMode = runtimeMode,
        createdAtMs = 1,
        attempts = 0,
        nextAttemptAtMs = 0,
        deliveryState = OutboxDeliveryState.Pending,
        legacyRawJson = legacyRawJson,
    )

    private class MutableAvailability(
        var generation: Long,
        var ready: Boolean = true,
        var durable: Boolean = true,
    ) : OutboxCapabilityLookup {
        override fun lookup(turn: QueuedTurn) = OutboxConnectionAvailability(
            generation = generation,
            readiness = if (ready) {
                app.switchboard.mobile.domain.outbox.DeliveryReadiness.Ready
            } else {
                app.switchboard.mobile.domain.outbox.DeliveryReadiness.Offline
            },
            capabilities = if (durable) setOf(DURABLE_TURN_ORIGIN_CAPABILITY) else emptySet(),
        )
    }

    private class FakeRpc(
        override var scope: TransportScope? = TransportScope("phone", "mac-a", 4),
        var submission: RequestSubmission = RequestSubmission.Accepted(
            requestId = 1,
            scope = requireNotNull(scope),
        ),
        var synchronousOutcome: RpcOutcome? = null,
    ) : RemoteRpc {
        var invocations = 0
        lateinit var lastArgs: JsonArray
        private var callback: ((RpcOutcome) -> Unit)? = null

        override fun invoke(
            expectedScope: TransportScope,
            channel: String,
            args: JsonArray,
            callback: (RpcOutcome) -> Unit,
        ): RequestSubmission {
            invocations++
            lastArgs = args
            this.callback = callback
            synchronousOutcome?.let(callback)
            return submission
        }

        override fun onRuntimeEvent(listener: (TransportScope, RuntimeEventPayload) -> Unit) =
            Cancelable {}

        fun reply(outcome: RpcOutcome) {
            callback?.invoke(outcome)
        }
    }

    private fun obj(vararg fields: Pair<String, app.switchboard.mobile.protocol.JsonValue>) =
        JsonObject(linkedMapOf(*fields))
}
