package app.switchboard.mobile.domain.google

import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString

data class GoogleClientConfig(
    val clientId: String,
    val clientSecret: String? = null,
)

data class GoogleCredentialBundle(
    val clientId: String,
    val clientSecret: String? = null,
    val refreshToken: String,
    val accessToken: String? = null,
    val expiresAtEpochMs: Long? = null,
    val email: String? = null,
)

object GoogleCredentialImport {
    fun parse(raw: String, fallbackClient: GoogleClientConfig?): GoogleCredentialBundle? {
        val text = raw.trim()
        if (text.startsWith("1//")) {
            val fallback = fallbackClient?.normalized() ?: return null
            return GoogleCredentialBundle(
                clientId = fallback.clientId,
                clientSecret = fallback.clientSecret,
                refreshToken = text,
            )
        }
        if (!text.startsWith('{')) return null

        return try {
            val root = JsonCodec.parse(text) as? JsonObject ?: return null
            val clientId = root.string("clientId")?.trim().orEmpty()
            val refreshToken = root.string("refreshToken")?.trim().orEmpty()
            val clientSecret = root.string("clientSecret")?.trim()?.takeIf(String::isNotEmpty)
            if (clientId.isEmpty() || refreshToken.isEmpty()) return null
            GoogleCredentialBundle(clientId, clientSecret, refreshToken)
        } catch (_: IllegalArgumentException) {
            null
        } catch (_: IllegalStateException) {
            null
        }
    }

    private fun GoogleClientConfig.normalized(): GoogleClientConfig? {
        val id = clientId.trim()
        if (id.isEmpty()) return null
        return GoogleClientConfig(id, clientSecret?.trim()?.takeIf(String::isNotEmpty))
    }

    private fun JsonObject.string(key: String): String? = (values[key] as? JsonString)?.value
}
