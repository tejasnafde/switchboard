package app.switchboard.mobile.platform.outbox

import app.switchboard.mobile.data.outbox.OutboxImageMaterialization
import app.switchboard.mobile.domain.outbox.OutboxDeliveryState
import app.switchboard.mobile.domain.outbox.QueuedTurn
import app.switchboard.mobile.domain.outbox.StagedAttachment
import java.io.FileNotFoundException
import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OutboxImageMaterializerTest {
    @Test
    fun materializesPrivateBytesAsBackendDataUrls() {
        val materializer = PrivateFileOutboxImageMaterializer(
            OutboxPrivateFileReader { byteArrayOf(1, 2, 3) },
        )

        val result = materializer.materialize(turn(StagedAttachment("/private/one", "image/png")))

        val image = (result as OutboxImageMaterialization.Success).images.single()
        assertEquals("data:image/png;base64,AQID", image.url)
        assertEquals("image/png", image.mimeType)
        assertFalse(image.url.contains("/private/one"))
    }

    @Test
    fun rejectsAnEncodedTurnOverThreeMibBeforeRemoteInvocation() {
        val materializer = PrivateFileOutboxImageMaterializer(
            OutboxPrivateFileReader { ByteArray(3 * 1024 * 1024) },
        )

        val result = materializer.materialize(turn(StagedAttachment("/private/large", "image/jpeg")))

        assertTrue(result is OutboxImageMaterialization.Failure)
        assertEquals(
            "Images exceed the 3 MiB synchronization limit",
            (result as OutboxImageMaterialization.Failure).reason,
        )
    }

    @Test
    fun rejectsAggregateEncodedPayloadOverThreeMib() {
        val materializer = PrivateFileOutboxImageMaterializer(
            OutboxPrivateFileReader { ByteArray(1_200_000) },
        )

        val result = materializer.materialize(
            turn(
                StagedAttachment("/private/one", "image/png"),
                StagedAttachment("/private/two", "image/png"),
            ),
        )

        assertTrue(result is OutboxImageMaterialization.Failure)
    }

    @Test
    fun rejectsUnsupportedOrUnknownMimeTypesWithAnActionableFailure() {
        val materializer = PrivateFileOutboxImageMaterializer(
            OutboxPrivateFileReader { byteArrayOf(1, 2, 3) },
        )

        val unsupported = materializer.materialize(
            turn(StagedAttachment("/private/photo", "image/heic")),
        )
        val unknown = materializer.materialize(
            turn(StagedAttachment("/private/photo", null)),
        )

        assertEquals(
            "Images must be PNG, JPEG, WebP, or GIF data URLs",
            (unsupported as OutboxImageMaterialization.Failure).reason,
        )
        assertEquals(
            "Images must be PNG, JPEG, WebP, or GIF data URLs",
            (unknown as OutboxImageMaterialization.Failure).reason,
        )
    }

    @Test
    fun canonicalizesJpgAndInfersMissingMimeFromImageBytes() {
        val jpeg = byteArrayOf(
            0xFF.toByte(),
            0xD8.toByte(),
            0xFF.toByte(),
            0xE0.toByte(),
            0x00,
        )
        val materializer = PrivateFileOutboxImageMaterializer(
            OutboxPrivateFileReader { jpeg },
        )

        val reportedJpg = materializer.materialize(
            turn(StagedAttachment("/private/reported-jpg", "image/jpg")),
        ) as OutboxImageMaterialization.Success
        val inferred = materializer.materialize(
            turn(StagedAttachment("/private/missing-type", null)),
        ) as OutboxImageMaterialization.Success

        assertEquals("image/jpeg", reportedJpg.images.single().mimeType)
        assertTrue(reportedJpg.images.single().url.startsWith("data:image/jpeg;base64,"))
        assertEquals("image/jpeg", inferred.images.single().mimeType)
        assertTrue(inferred.images.single().url.startsWith("data:image/jpeg;base64,"))
    }

    @Test
    fun acceptsMoreThanFourImagesWhenTheirCombinedWirePayloadFits() {
        var reads = 0
        val materializer = PrivateFileOutboxImageMaterializer(
            OutboxPrivateFileReader {
                reads += 1
                byteArrayOf(1)
            },
        )

        val result = materializer.materialize(
            turn(
                *Array(5) { index ->
                    StagedAttachment("/private/$index", "image/png")
                },
            ),
        )

        assertTrue(result is OutboxImageMaterialization.Success)
        assertEquals(5, (result as OutboxImageMaterialization.Success).images.size)
        assertEquals(5, reads)
    }

    @Test
    fun readFailureIsGenericAndDoesNotExposeThePrivatePath() {
        val materializer = PrivateFileOutboxImageMaterializer(
            OutboxPrivateFileReader { throw FileNotFoundException("/private/secret-name") },
        )

        val result = materializer.materialize(turn(StagedAttachment("/private/secret-name", "image/png")))

        assertTrue(result is OutboxImageMaterialization.Failure)
        assertFalse((result as OutboxImageMaterialization.Failure).reason.contains("secret-name"))
    }

    @Test
    fun rejectsLegacyDataUrlOverThreeMibEncoded() {
        val encoded = Base64.getEncoder().encodeToString(ByteArray(3 * 1024 * 1024))
        val materializer = PrivateFileOutboxImageMaterializer(
            OutboxPrivateFileReader { error("legacy image should not read a private file") },
        )

        val result = materializer.materialize(
            turn(
                legacyRawJson =
                    """{"images":[{"url":"data:image/png;base64,$encoded","mimeType":"image/png"}]}""",
            ),
        )

        assertTrue(result is OutboxImageMaterialization.Failure)
    }

    @Test
    fun rejectsUnsupportedLegacyImageType() {
        val materializer = PrivateFileOutboxImageMaterializer(
            OutboxPrivateFileReader { error("legacy image should not read a private file") },
        )

        val result = materializer.materialize(
            turn(
                legacyRawJson =
                    """{"images":[{"url":"data:image/heic;base64,AQID","mimeType":"image/heic"}]}""",
            ),
        )

        assertEquals(
            "Images must be PNG, JPEG, WebP, or GIF data URLs",
            (result as OutboxImageMaterialization.Failure).reason,
        )
    }

    private fun turn(
        vararg attachments: StagedAttachment,
        legacyRawJson: String? = null,
    ) = QueuedTurn(
        connectionId = "mac-a",
        threadId = "thread-a",
        origin = "origin",
        bubbleId = "remote_origin",
        text = "hello",
        attachments = attachments.toList(),
        runtimeMode = null,
        createdAtMs = 1,
        attempts = 0,
        nextAttemptAtMs = 0,
        deliveryState = OutboxDeliveryState.Pending,
        legacyRawJson = legacyRawJson,
    )
}
