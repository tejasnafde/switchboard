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
    fun rejectsAnImageOverEightMibBeforeRemoteInvocation() {
        val materializer = PrivateFileOutboxImageMaterializer(
            OutboxPrivateFileReader { ByteArray(8 * 1024 * 1024 + 1) },
        )

        val result = materializer.materialize(turn(StagedAttachment("/private/large", "image/jpeg")))

        assertTrue(result is OutboxImageMaterialization.Failure)
    }

    @Test
    fun rejectsAggregateDataUrlWirePayloadOverTwelveMib() {
        val materializer = PrivateFileOutboxImageMaterializer(
            OutboxPrivateFileReader { ByteArray(5 * 1024 * 1024) },
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
    fun readFailureIsGenericAndDoesNotExposeThePrivatePath() {
        val materializer = PrivateFileOutboxImageMaterializer(
            OutboxPrivateFileReader { throw FileNotFoundException("/private/secret-name") },
        )

        val result = materializer.materialize(turn(StagedAttachment("/private/secret-name", null)))

        assertTrue(result is OutboxImageMaterialization.Failure)
        assertFalse((result as OutboxImageMaterialization.Failure).reason.contains("secret-name"))
    }

    @Test
    fun rejectsLegacyDataUrlOverEightMib() {
        val encoded = Base64.getEncoder().encodeToString(ByteArray(8 * 1024 * 1024 + 1))
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
