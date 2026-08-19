package app.switchboard.mobile.platform.outbox

import app.switchboard.mobile.data.outbox.OutboxImageMaterialization
import app.switchboard.mobile.data.outbox.OutboxImageMaterializer
import app.switchboard.mobile.domain.outbox.QueuedTurn
import app.switchboard.mobile.domain.remote.ImageInput
import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import java.io.File
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi

fun interface OutboxPrivateFileReader {
    fun read(path: String): ByteArray
}

@OptIn(ExperimentalEncodingApi::class)
class PrivateFileOutboxImageMaterializer(
    private val files: OutboxPrivateFileReader = OutboxPrivateFileReader { path ->
        File(path).readBytes()
    },
) : OutboxImageMaterializer {
    override fun materialize(turn: QueuedTurn): OutboxImageMaterialization {
        var aggregateWireBytes = 0L
        val images = ArrayList<ImageInput>(turn.attachments.size)
        return try {
            val legacy = legacyImages(turn.legacyRawJson)
            if (turn.attachments.size + legacy.size > MAX_IMAGES) {
                return OutboxImageMaterialization.Failure(TOO_MANY_IMAGES)
            }

            fun addDataUrl(url: String, mimeType: String?): String? {
                val match = DATA_URL.matchEntire(url) ?: return UNSUPPORTED_IMAGE_TYPE
                val encodedMimeType = match.groupValues[1]
                if (encodedMimeType !in SUPPORTED_MIME_TYPES) return UNSUPPORTED_IMAGE_TYPE
                if (mimeType != null && mimeType != encodedMimeType) return MIME_TYPE_MISMATCH
                aggregateWireBytes += url.toByteArray(Charsets.UTF_8).size
                if (aggregateWireBytes > MAX_AGGREGATE_WIRE_BYTES) return IMAGES_TOO_LARGE
                images += ImageInput(url, mimeType)
                return null
            }

            turn.attachments.forEach { attachment ->
                val mimeType = attachment.mimeType
                if (mimeType !in SUPPORTED_MIME_TYPES) {
                    return OutboxImageMaterialization.Failure(UNSUPPORTED_IMAGE_TYPE)
                }
                val bytes = files.read(attachment.privateUri)
                val dataUrl = "data:$mimeType;base64,${Base64.encode(bytes)}"
                addDataUrl(dataUrl, mimeType)?.let { reason ->
                    return OutboxImageMaterialization.Failure(reason)
                }
            }

            legacy.forEach { image ->
                addDataUrl(image.url, image.mimeType)?.let { reason ->
                    return OutboxImageMaterialization.Failure(reason)
                }
            }
            OutboxImageMaterialization.Success(images)
        } catch (_: Exception) {
            OutboxImageMaterialization.Failure("A staged attachment could not be read")
        }
    }

    private fun legacyImages(rawJson: String?): List<ImageInput> {
        if (rawJson == null) return emptyList()
        val root = JsonCodec.parse(rawJson) as? JsonObject
            ?: error("legacy outbox payload must be an object")
        val encodedImages = when (val value = root.values["images"]) {
            null, JsonNull -> return emptyList()
            is JsonArray -> value.values
            else -> error("legacy outbox images must be an array")
        }
        return encodedImages.map { encoded ->
            val image = encoded as? JsonObject ?: error("legacy outbox image must be an object")
            val url = (image.values["url"] as? JsonString)?.value
                ?: error("legacy outbox image URL is missing")
            require(url.startsWith("data:") && BASE64_MARKER in url) {
                "legacy outbox image must be a base64 data URL"
            }
            val mimeType = when (val value = image.values["mimeType"]) {
                null, JsonNull -> null
                is JsonString -> value.value
                else -> error("legacy outbox image MIME type must be a string")
            }
            ImageInput(url, mimeType)
        }
    }

    private companion object {
        const val MAX_IMAGES = 4
        const val MAX_AGGREGATE_WIRE_BYTES = 3 * 1024 * 1024
        const val BASE64_MARKER = ";base64,"
        const val TOO_MANY_IMAGES = "A turn can include at most 4 images"
        const val UNSUPPORTED_IMAGE_TYPE = "Images must be PNG, JPEG, WebP, or GIF data URLs"
        const val MIME_TYPE_MISMATCH = "Image MIME type does not match its data URL"
        const val IMAGES_TOO_LARGE = "Images exceed the 3 MiB synchronization limit"
        val SUPPORTED_MIME_TYPES = setOf("image/png", "image/jpeg", "image/webp", "image/gif")
        val DATA_URL = Regex("^data:(image/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$")
    }
}
