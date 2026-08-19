package app.switchboard.mobile.ui.thread

import java.net.URI

data class ThreadImageData(
    val mimeType: String,
    val base64: String,
    val decodedBytes: Int,
) {
    companion object {
        const val MaxDecodedBytes = 20 * 1024 * 1024

        private val Header = Regex(
            pattern = "^data:(image/(?:png|jpeg|jpg|webp|gif));base64,(.+)$",
            option = RegexOption.IGNORE_CASE,
        )
        private val Base64Body = Regex("^[A-Za-z0-9+/]*={0,2}$")

        fun parse(
            url: String,
            maxDecodedBytes: Int = MaxDecodedBytes,
        ): ThreadImageData? {
            val match = Header.matchEntire(url) ?: return null
            val body = match.groupValues[2]
            if (body.length % 4 != 0 || !Base64Body.matches(body)) return null
            val padding = when {
                body.endsWith("==") -> 2
                body.endsWith('=') -> 1
                else -> 0
            }
            val decodedBytes = (body.length / 4L) * 3L - padding
            if (decodedBytes !in 1..maxDecodedBytes.toLong()) return null
            return ThreadImageData(
                mimeType = match.groupValues[1].lowercase(),
                base64 = body,
                decodedBytes = decodedBytes.toInt(),
            )
        }
    }
}

data class ThreadImageFile(val path: String) {
    companion object {
        fun parse(url: String): ThreadImageFile? {
            val uri = runCatching { URI(url) }.getOrNull() ?: return null
            if (!uri.scheme.equals("file", ignoreCase = true)) return null
            if (!uri.authority.isNullOrEmpty() || uri.query != null || uri.fragment != null) return null
            val path = runCatching { uri.path }.getOrNull()?.takeIf { it.startsWith('/') }
                ?: return null
            return ThreadImageFile(path)
        }
    }
}
