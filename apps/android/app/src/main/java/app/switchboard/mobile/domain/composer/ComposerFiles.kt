package app.switchboard.mobile.domain.composer

import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue
import java.text.NumberFormat
import java.util.Locale
import java.util.UUID

/** A file saved on the backend over `app:upload-attachment`, ready to go in a turn. */
data class UploadedFile(
    val name: String,
    val path: String,
    val label: String,
    /** When the phone got the saved path; null on a file attached before this was kept. */
    val savedAtMs: Long? = null,
) {
    /** Stable for one saved copy, so a retried turn keeps the backend's origin fingerprint. */
    val pillId: String get() = "file-" + UUID.nameUUIDFromBytes(path.toByteArray(Charsets.UTF_8))
}

/** The turn for typed text plus uploaded files. */
data class FileAttachmentTurn(
    val providerText: String,
    val displayBody: String,
    /** pill id to label; the kind is always `file`. */
    val pillsMeta: Map<String, String>,
)

/**
 * Non-image attachments: which picked files are uploaded, which are refused,
 * and the turn they make. Port of `src/shared/attachments.ts` and the desktop
 * intake (`src/renderer/services/attachment-intake.ts`); keep the numbers and
 * the copy in step.
 */
object ComposerFiles {
    const val UPLOAD_CAPABILITY = "attachment_upload_v1"

    /** Largest file a phone uploads (`MAX_UPLOAD_ATTACHMENT_BYTES`). */
    const val MAX_UPLOAD_BYTES = 10L * 1024 * 1024

    /** Pasted text over this many UTF-8 bytes becomes a `pasted-text-N.txt` attachment. */
    const val LARGE_PASTE_BYTES = 32 * 1024

    /**
     * A draft or queued attachment with this MIME type is a file already saved
     * on the backend: its `privateUri` holds [encode]'s JSON, not a phone path.
     */
    const val UPLOADED_FILE_MIME = "application/x-switchboard-uploaded-file"

    /**
     * The backend deletes saved copies older than 30 days (`KEEP_DAYS` in
     * `src/main/attachments.ts`). A queued file older than this is refused
     * before it sends; the day of margin covers clock skew.
     */
    const val SENDABLE_FOR_MS = 29L * 24 * 60 * 60 * 1000

    private val IMAGE_TYPES = setOf("image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif", "image/heic", "image/heif")
    private val IMAGE_EXTENSIONS = mapOf(
        "png" to "image/png",
        "jpg" to "image/jpeg",
        "jpeg" to "image/jpeg",
        "webp" to "image/webp",
        "gif" to "image/gif",
        "heic" to "image/heic",
        "heif" to "image/heif",
    )

    data class Intake(
        val images: List<ComposerImageSource>,
        val files: List<ComposerImageSource>,
        val refused: List<String>,
    )

    /**
     * Split picked files into images (shrunk and sent inline), files (uploaded
     * and sent as a path) and refusals. An SVG goes as a file: no provider
     * takes it as an image. Without [uploads] only images are taken.
     */
    fun sort(sources: List<ComposerImageSource>, uploads: Boolean): Intake {
        val images = mutableListOf<ComposerImageSource>()
        val files = mutableListOf<ComposerImageSource>()
        val refused = mutableListOf<String>()
        sources.forEach { source ->
            val type = typeOf(source)
            val size = source.sizeBytes
            when {
                type in IMAGE_TYPES -> images += source
                type.startsWith("image/") && type != "image/svg+xml" -> refused += refusal(
                    source.displayName,
                    "${type.removePrefix("image/").substringBefore('+').uppercase()} images are not supported. " +
                        "Use PNG, JPEG, WebP, GIF or HEIC.",
                )
                !uploads -> refused += refusal(
                    source.displayName,
                    "Only images can be attached. Update Switchboard on the computer to attach other files.",
                )
                size != null && size > MAX_UPLOAD_BYTES -> refused += tooLarge(source.displayName, size)
                else -> files += source
            }
        }
        return Intake(images, files, refused)
    }

    fun refusal(name: String, reason: String): String = "$name was not attached: $reason"

    fun tooLarge(name: String, size: Long): String =
        refusal(name, "${megabytes(size)} is over the ${megabytes(MAX_UPLOAD_BYTES)} file limit.")

    private fun megabytes(bytes: Long): String = "${(bytes + 1024 * 1024 - 1) / (1024 * 1024)} MB"

    private fun typeOf(source: ComposerImageSource): String {
        val reported = source.mimeType?.trim()?.lowercase().orEmpty()
        if (reported.isNotEmpty() && reported != "application/octet-stream") return reported
        val extension = source.displayName.substringAfterLast('.', "").lowercase()
        return IMAGE_EXTENSIONS[extension] ?: reported
    }

    /** The next free `pasted-text-N.txt` name, given the labels of the chips already attached. */
    fun nextPastedTextName(labels: List<String>): String {
        val pattern = Regex("^pasted-text-(\\d+)\\.txt")
        val used = labels.map { label -> pattern.find(label)?.groupValues?.get(1)?.toIntOrNull() ?: 0 }
        return "pasted-text-${(used.maxOrNull() ?: 0) + 1}.txt"
    }

    /** The chip label of a saved file: `spec.pdf (12 pages)`, `log.txt (2,140 lines)`, or the name. */
    fun label(name: String, pages: Int? = null, lines: Int? = null): String {
        val count = NumberFormat.getIntegerInstance(Locale.US)
        return when {
            pages != null && pages > 1 -> "$name (${count.format(pages)} pages)"
            lines != null && lines > 1 -> "$name (${count.format(lines)} lines)"
            else -> name
        }
    }

    /** Lines of pasted text, as the desktop counts them. */
    fun lineCount(text: String): Int = text.split('\n').size

    /**
     * The run of text one edit inserted, when it is over [LARGE_PASTE_BYTES]
     * in UTF-8, with the text the field keeps; null for any other edit.
     */
    fun largePaste(previous: String, next: String): LargePaste? {
        if (next.length <= previous.length) return null
        var start = 0
        val limit = previous.length
        while (start < limit && previous[start] == next[start]) start++
        var suffix = 0
        while (suffix < limit - start && previous[previous.length - 1 - suffix] == next[next.length - 1 - suffix]) suffix++
        // Only a pure insertion: the old text must survive around the new run.
        if (start + suffix != previous.length) return null
        val inserted = next.substring(start, next.length - suffix)
        if (inserted.toByteArray(Charsets.UTF_8).size <= LARGE_PASTE_BYTES) return null
        return LargePaste(inserted = inserted, kept = previous, offset = start)
    }

    /** [offset] is where [inserted] went in [kept]. */
    data class LargePaste(val inserted: String, val kept: String, val offset: Int) {
        /** Puts the paste back at its place in [current], or at the end when [current] is now shorter. */
        fun restore(current: String): String {
            val at = offset.coerceAtMost(current.length)
            return current.substring(0, at) + inserted + current.substring(at)
        }
    }

    fun attachment(id: String, file: UploadedFile): ComposerAttachment = ComposerAttachment(
        id = id,
        privateUri = encode(file),
        mimeType = UPLOADED_FILE_MIME,
        displayName = file.label,
    )

    fun encode(file: UploadedFile): String = JsonCodec.encode(
        JsonObject(
            linkedMapOf<String, JsonValue>(
                "name" to JsonString(file.name),
                "path" to JsonString(file.path),
                "label" to JsonString(file.label),
            ).apply { file.savedAtMs?.let { put("savedAtMs", JsonNumber(it.toString())) } },
        ),
    )

    /** The saved file a draft or queued attachment names; null for an image. */
    fun uploaded(privateUri: String, mimeType: String?): UploadedFile? {
        if (mimeType != UPLOADED_FILE_MIME) return null
        val values = (runCatching { JsonCodec.parse(privateUri) }.getOrNull() as? JsonObject)?.values ?: return null
        fun field(key: String) = (values[key] as? JsonString)?.value
        val path = field("path") ?: return null
        val name = field("name") ?: return null
        val savedAtMs = (values["savedAtMs"] as? JsonNumber)?.source?.toLongOrNull()
        return UploadedFile(name = name, path = path, label = field("label") ?: name, savedAtMs = savedAtMs)
    }

    fun isUploaded(mimeType: String?): Boolean = mimeType == UPLOADED_FILE_MIME

    /**
     * The desktop's turn shape (`attachmentTurn`): the provider text ends with
     * one `[Attached file "x" is saved at: /path]` line per file, the display
     * body with one `[[pill:id]]` token per file. [displayText] is the body
     * text when it differs from [text] (a review pill's chip).
     */
    fun turn(text: String, files: List<UploadedFile>, displayText: String = text): FileAttachmentTurn {
        if (files.isEmpty()) return FileAttachmentTurn(text, displayText, emptyMap())
        fun join(head: String, tail: List<String>) =
            listOf(head, tail.joinToString("\n")).filter(String::isNotEmpty).joinToString("\n\n")
        return FileAttachmentTurn(
            providerText = join(text, files.map { "[Attached file \"${it.name}\" is saved at: ${it.path}]" }),
            displayBody = join(displayText, files.map { "[[pill:${it.pillId}]]" }),
            pillsMeta = files.associate { it.pillId to it.label },
        )
    }
}
