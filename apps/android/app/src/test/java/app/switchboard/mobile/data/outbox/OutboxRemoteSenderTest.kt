package app.switchboard.mobile.data.outbox

import app.switchboard.mobile.data.remote.RemoteRpc
import app.switchboard.mobile.data.remote.SwitchboardRemoteClient
import app.switchboard.mobile.domain.composer.ComposerFiles
import app.switchboard.mobile.domain.composer.UploadedFile
import app.switchboard.mobile.domain.outbox.OutboxDeliveryState
import app.switchboard.mobile.domain.outbox.QueuedReviewPill
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

    @Test
    fun atomicBackendGetsTheEnvelopeAndOnlyAQueueCapableOneGetsDelivery() {
        val rpc = FakeRpc(synchronousOutcome = RpcOutcome.Success(null))
        val envelope = MutableAvailability(4, extra = setOf(ATOMIC_USER_TURN_CAPABILITY, "turn_queue_v1"))
        sender(rpc, envelope).send(turn(delivery = "queue"), {})

        assertEquals("provider:submit-user-turn", rpc.lastChannel)
        val body = rpc.lastArgs.values.single() as JsonObject
        assertEquals(JsonString("queue"), body.values["delivery"])
        assertEquals(JsonString("origin-1"), body.values["origin"])
        assertEquals(JsonString("hello"), body.values["providerText"])
        assertEquals(JsonString("sandbox"), body.values["runtimeMode"])
        // Same as send-turn sets, so a row first tried there keeps its fingerprint.
        assertEquals(JsonString("hello"), body.values["autoTitleText"])

        val noQueue = MutableAvailability(4, extra = setOf(ATOMIC_USER_TURN_CAPABILITY))
        sender(rpc, noQueue).send(turn(origin = "origin-2", delivery = "queue"), {})
        assertEquals(null, (rpc.lastArgs.values.single() as JsonObject).values["delivery"])
    }

    @Test
    fun aReviewPillRidesTheEnvelopeAsAChipAndItsContent() {
        val rpc = FakeRpc(synchronousOutcome = RpcOutcome.Success(null))
        val envelope = MutableAvailability(4, extra = setOf(ATOMIC_USER_TURN_CAPABILITY))
        val pill = QueuedReviewPill("review-1", "1 failed check · #7 · lint", "CONTEXT")
        sender(rpc, envelope).send(turn(reviewPill = pill), {})

        val body = rpc.lastArgs.values.single() as JsonObject
        assertEquals(JsonString("CONTEXT\n\nhello"), body.values["providerText"])
        assertEquals(JsonString("[[pill:review-1]] hello"), body.values["displayBody"])
        val meta = (body.values["pillsMeta"] as JsonObject).values["review-1"] as JsonObject
        assertEquals(JsonString("1 failed check · #7 · lint"), meta.values["label"])
        assertEquals(JsonString("review"), meta.values["kind"])

        // An older backend has no display body; the agent still reads the context.
        sender(rpc).send(turn(origin = "origin-2", reviewPill = pill), {})
        assertEquals(JsonString("CONTEXT\n\nhello"), rpc.lastArgs.values[1])
    }

    @Test
    fun anUploadedFileRidesAsAPromptLineAndAFileChip() {
        val rpc = FakeRpc(synchronousOutcome = RpcOutcome.Success(null))
        val envelope = MutableAvailability(4, extra = setOf(ATOMIC_USER_TURN_CAPABILITY))
        val file = UploadedFile("spec.pdf", "/att/1/spec.pdf", "spec.pdf (2 pages)")
        val staged = StagedAttachment(ComposerFiles.encode(file), ComposerFiles.UPLOADED_FILE_MIME)
        val noImages = OutboxImageMaterializer { OutboxImageMaterialization.Success(emptyList()) }
        sender(rpc, envelope, noImages).send(turn(attachments = listOf(staged)), {})

        val body = rpc.lastArgs.values.single() as JsonObject
        assertEquals(JsonString("hello\n\n[Attached file \"spec.pdf\" is saved at: /att/1/spec.pdf]"), body.values["providerText"])
        assertEquals(JsonString("hello\n\n[[pill:${file.pillId}]]"), body.values["displayBody"])
        val meta = (body.values["pillsMeta"] as JsonObject).values[file.pillId] as JsonObject
        assertEquals(JsonString("spec.pdf (2 pages)"), meta.values["label"])
        assertEquals(JsonString("file"), meta.values["kind"])

        // The real materializer leaves the uploaded file out of the images.
        val images = PrivateFileOutboxImageMaterializer { error("an uploaded file is never read on the phone") }
        assertEquals(OutboxImageMaterialization.Success(emptyList()), images.materialize(turn(attachments = listOf(staged))))
    }

    @Test
    fun aFileThatDoesNotDecodeOrWasPrunedIsRefusedBeforeSending() {
        val rpc = FakeRpc(synchronousOutcome = RpcOutcome.Success(null))
        val noImages = OutboxImageMaterializer { OutboxImageMaterialization.Success(emptyList()) }
        val outcomes = mutableListOf<SendOutcome>()
        val broken = StagedAttachment("not json", ComposerFiles.UPLOADED_FILE_MIME)
        sender(rpc, materializer = noImages).send(turn(attachments = listOf(broken)), outcomes::add)

        val old = UploadedFile("a.pdf", "/att/a.pdf", "a.pdf", savedAtMs = 10)
        val staged = StagedAttachment(ComposerFiles.encode(old), ComposerFiles.UPLOADED_FILE_MIME)
        val late = OutboxClock { 10 + ComposerFiles.SENDABLE_FOR_MS + 1 }
        sender(rpc, materializer = noImages, clock = late).send(turn(attachments = listOf(staged)), outcomes::add)

        assertEquals(null, rpc.lastChannel)
        assertEquals(2, outcomes.size)
        assertTrue(outcomes.all { it is SendOutcome.Permanent })

        // Inside the window it sends.
        val fresh = OutboxClock { 10 + ComposerFiles.SENDABLE_FOR_MS }
        sender(rpc, materializer = noImages, clock = fresh).send(turn(attachments = listOf(staged)), outcomes::add)
        assertEquals("provider:send-turn", rpc.lastChannel)
    }

    @Test
    fun aReviewPillSurvivesTheOutboxRow() {
        val pill = QueuedReviewPill("review-1", "label", "content \"quoted\"")
        val queued = turn(reviewPill = pill)
        val rows = OutboxEntityMapper.toRows(queued)
        assertEquals(
            queued,
            OutboxEntityMapper.toDomain(app.switchboard.mobile.data.local.OutboxWithAttachments(rows.message, rows.attachments)),
        )
        assertEquals(null, OutboxEntityMapper.toRows(turn()).message.reviewPillJson)
    }

    @Test
    fun olderBackendKeepsThePositionalSend() {
        val rpc = FakeRpc(synchronousOutcome = RpcOutcome.Success(null))
        sender(rpc).send(turn(delivery = "queue"), {})

        assertEquals("provider:send-turn", rpc.lastChannel)
        assertEquals(JsonString("hello"), rpc.lastArgs.values[1])
    }

    private fun sender(
        rpc: FakeRpc,
        availability: MutableAvailability = MutableAvailability(rpc.scope!!.generation),
        materializer: OutboxImageMaterializer = OutboxImageMaterializer {
            OutboxImageMaterialization.Success(listOf(ImageInput("data:image/png;base64,AQID", "image/png")))
        },
        clock: OutboxClock = OutboxClock { 1 },
    ) = OutboxRemoteSender(
        clients = OutboxClientLookup { SwitchboardRemoteClient(it, rpc) },
        capabilities = availability,
        images = materializer,
        clock = clock,
    )

    private fun turn(
        origin: String = "origin-1",
        runtimeMode: String? = "sandbox",
        attachments: List<StagedAttachment> = emptyList(),
        legacyRawJson: String? = null,
        delivery: String? = null,
        reviewPill: QueuedReviewPill? = null,
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
        delivery = delivery,
        reviewPill = reviewPill,
    )

    private class MutableAvailability(
        var generation: Long,
        var ready: Boolean = true,
        var durable: Boolean = true,
        val extra: Set<String> = emptySet(),
    ) : OutboxCapabilityLookup {
        override fun lookup(turn: QueuedTurn) = OutboxConnectionAvailability(
            generation = generation,
            readiness = if (ready) {
                app.switchboard.mobile.domain.outbox.DeliveryReadiness.Ready
            } else {
                app.switchboard.mobile.domain.outbox.DeliveryReadiness.Offline
            },
            capabilities = (if (durable) setOf(DURABLE_TURN_ORIGIN_CAPABILITY) else emptySet()) + extra,
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
        var lastChannel: String? = null
        private var callback: ((RpcOutcome) -> Unit)? = null

        override fun invoke(
            expectedScope: TransportScope,
            channel: String,
            args: JsonArray,
            callback: (RpcOutcome) -> Unit,
        ): RequestSubmission {
            invocations++
            lastArgs = args
            lastChannel = channel
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
