package app.switchboard.mobile.domain.thread

import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue
import java.security.MessageDigest

/** `HtmlLiveChannels.LOAD` answer (shared/html-live.ts `HtmlLiveState`). */
data class HtmlLiveState(
    /** A `data:image/png;base64,...` (or jpeg) still image the desktop took, or null. */
    val image: String?,
    val savedPath: String?,
)

/**
 * Port of the parts of src/shared/html-live.ts a phone needs. A phone never
 * runs the page: it shows the still image the desktop stored under [imageKey].
 */
object HtmlLivePages {
    const val FENCE = "html-live"
    const val CAPABILITY = "html_live_images_v1"
    /** Height of the folded image, as the desktop's folded frame. */
    const val MAX_HEIGHT = 480
    private const val MAX_TITLE_CHARS = 120
    private val titlePattern = Regex("\\btitle=(?:\"([^\"]*)\"|'([^']*)')")
    private val imagePattern = Regex("^data:image/(png|jpeg);base64,([A-Za-z0-9+/]+=*)$")

    data class Info(val title: String?)

    /** `html-live title="Chart"` -> Info("Chart"); null when the info string is another language. */
    fun parseInfo(info: String): Info? {
        val trimmed = info.trim()
        if (trimmed.split(Regex("\\s+")).firstOrNull()?.lowercase() != FENCE) return null
        val match = titlePattern.find(trimmed)
        val raw = match?.groups?.get(1)?.value ?: match?.groups?.get(2)?.value ?: ""
        return Info(raw.trim().take(MAX_TITLE_CHARS).ifEmpty { null })
    }

    /** Lowercase hex SHA-256 of the source's UTF-8 bytes: the key the desktop stores the image under. */
    fun imageKey(source: String): String =
        MessageDigest.getInstance("SHA-256").digest(source.toByteArray(Charsets.UTF_8))
            .joinToString("") { byte -> (byte.toInt() and 0xff).toString(16).padStart(2, '0') }

    /** The base64 payload of a PNG or JPEG data URL, or null for anything else. */
    fun imageBase64(dataUrl: String): String? = imagePattern.matchEntire(dataUrl)?.groupValues?.get(2)

    fun decodeState(value: JsonValue?): HtmlLiveState {
        val obj = value as? JsonObject ?: return HtmlLiveState(null, null)
        val image = (obj.values["image"] as? JsonString)?.value?.takeIf { imageBase64(it) != null }
        return HtmlLiveState(image, (obj.values["savedPath"] as? JsonString)?.value)
    }

    const val OPENED = "Opened on your Mac"
    const val UNREACHABLE = "Could not reach your Mac"

    /** The line shown for an OPEN_ON_DESKTOP answer: the backend's own error (a rate limit) when it sends one. */
    fun decodeOpened(value: JsonValue?): String {
        val obj = value as? JsonObject ?: return UNREACHABLE
        if ((obj.values["ok"] as? JsonBoolean)?.value == true) return OPENED
        return (obj.values["error"] as? JsonString)?.value ?: UNREACHABLE
    }

    /** `HtmlLiveOpenRequest`: what OPEN_ON_DESKTOP sends. */
    fun openRequest(conversationId: String, source: String, title: String?): JsonObject = JsonObject(
        linkedMapOf(
            "conversationId" to JsonString(conversationId),
            "source" to JsonString(source),
            "title" to (title?.let(::JsonString) ?: JsonNull),
        ),
    )
}
