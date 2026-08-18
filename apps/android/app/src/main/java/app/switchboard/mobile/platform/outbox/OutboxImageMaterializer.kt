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
            fun addDataUrl(url: String, mimeType: String?, decodedBytes: Int): Boolean {
                if (decodedBytes > MAX_DECODED_BYTES_PER_IMAGE) return false
                aggregateWireBytes += url.toByteArray(Charsets.UTF_8).size
                if (aggregateWireBytes > MAX_AGGREGATE_WIRE_BYTES) return false
                images += ImageInput(url, mimeType)
                return true
            }

            turn.attachments.forEach { attachment ->
                val bytes = files.read(attachment.privateUri)
                val mimeType = attachment.mimeType ?: DEFAULT_MIME_TYPE
                val dataUrl = "data:$mimeType;base64,${Base64.encode(bytes)}"
                if (!addDataUrl(dataUrl, attachment.mimeType, bytes.size)) {
                    return OutboxImageMaterialization.Failure("Attachment exceeds the 8 MiB limit")
                }
            }

            legacyImages(turn.legacyRawJson).forEach { image ->
                val encoded = image.url.substringAfter(BASE64_MARKER, missingDelimiterValue = "")
                if (encoded.isEmpty() || encoded.length > MAX_ENCODED_CHARACTERS) {
                    return OutboxImageMaterialization.Failure("Legacy attachment is malformed or too large")
                }
                val decodedBytes = Base64.decode(encoded).size
                if (!addDataUrl(image.url, image.mimeType, decodedBytes)) {
                    return OutboxImageMaterialization.Failure("Attachments exceed the send limits")
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
        const val MAX_DECODED_BYTES_PER_IMAGE = 8 * 1024 * 1024
        const val MAX_AGGREGATE_WIRE_BYTES = 12 * 1024 * 1024
        const val MAX_ENCODED_CHARACTERS = ((MAX_DECODED_BYTES_PER_IMAGE + 2) / 3) * 4
        const val DEFAULT_MIME_TYPE = "application/octet-stream"
        const val BASE64_MARKER = ";base64,"
    }
}
