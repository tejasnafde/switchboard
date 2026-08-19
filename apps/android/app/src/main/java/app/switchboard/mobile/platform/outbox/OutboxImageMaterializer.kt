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
import java.io.ByteArrayOutputStream
import java.io.File
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi

fun interface OutboxPrivateFileReader {
    fun read(path: String): ByteArray
}

@OptIn(ExperimentalEncodingApi::class)
class PrivateFileOutboxImageMaterializer(
    private val files: OutboxPrivateFileReader = OutboxPrivateFileReader { path ->
        readBoundedPrivateFile(path)
    },
) : OutboxImageMaterializer {
    override fun materialize(turn: QueuedTurn): OutboxImageMaterialization {
        var aggregateWireBytes = 0L
        val images = ArrayList<ImageInput>(turn.attachments.size)
        return try {
            val legacy = legacyImages(turn.legacyRawJson)

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
                val bytes = files.read(attachment.privateUri)
                val mimeType = canonicalMimeType(attachment.mimeType, bytes)
                    ?: return OutboxImageMaterialization.Failure(UNSUPPORTED_IMAGE_TYPE)
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
        } catch (_: PrivateImageTooLarge) {
            OutboxImageMaterialization.Failure(IMAGES_TOO_LARGE)
        } catch (_: Exception) {
            OutboxImageMaterialization.Failure("A staged attachment could not be read")
        }
    }

    private fun canonicalMimeType(reported: String?, bytes: ByteArray): String? =
        when (reported?.trim()?.lowercase()) {
            "image/jpg" -> "image/jpeg"
            null, "" -> sniffMimeType(bytes)
            in SUPPORTED_MIME_TYPES -> reported.trim().lowercase()
            else -> null
        }

    private fun sniffMimeType(bytes: ByteArray): String? = when {
        bytes.startsWith(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A) -> "image/png"
        bytes.startsWith(0xFF, 0xD8, 0xFF) -> "image/jpeg"
        bytes.startsWithAscii("GIF87a") || bytes.startsWithAscii("GIF89a") -> "image/gif"
        bytes.startsWithAscii("RIFF") && bytes.hasAsciiAt(8, "WEBP") -> "image/webp"
        else -> null
    }

    private fun ByteArray.startsWith(vararg expected: Int): Boolean =
        size >= expected.size && expected.indices.all { index ->
            this[index].toInt() and 0xFF == expected[index]
        }

    private fun ByteArray.startsWithAscii(value: String): Boolean = hasAsciiAt(0, value)

    private fun ByteArray.hasAsciiAt(offset: Int, value: String): Boolean =
        size >= offset + value.length && value.indices.all { index ->
            this[offset + index].toInt() == value[index].code
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
        const val MAX_AGGREGATE_WIRE_BYTES = 3 * 1024 * 1024
        const val BASE64_MARKER = ";base64,"
        const val UNSUPPORTED_IMAGE_TYPE = "Images must be PNG, JPEG, WebP, or GIF data URLs"
        const val MIME_TYPE_MISMATCH = "Image MIME type does not match its data URL"
        const val IMAGES_TOO_LARGE = "Images exceed the 3 MiB synchronization limit"
        val SUPPORTED_MIME_TYPES = setOf("image/png", "image/jpeg", "image/webp", "image/gif")
        val DATA_URL = Regex("^data:(image/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$")

        private fun readBoundedPrivateFile(path: String): ByteArray {
            val file = File(path)
            if (file.length() > MAX_RAW_IMAGE_BYTES) throw PrivateImageTooLarge()
            return file.inputStream().use { input ->
                val output = ByteArrayOutputStream(file.length().coerceAtLeast(0).toInt())
                val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                var total = 0
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    total += read
                    if (total > MAX_RAW_IMAGE_BYTES) throw PrivateImageTooLarge()
                    output.write(buffer, 0, read)
                }
                output.toByteArray()
            }
        }

        private const val MAX_RAW_IMAGE_BYTES = MAX_AGGREGATE_WIRE_BYTES * 3 / 4
    }
}

private class PrivateImageTooLarge : Exception()
