package app.switchboard.mobile.domain.google

import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets

sealed interface GoogleOAuthCallback {
    data class AuthorizationCode(val code: String) : GoogleOAuthCallback
    data class Denied(val reason: String) : GoogleOAuthCallback
    data object Ignore : GoogleOAuthCallback
}

object GoogleOAuthCallbackPolicy {
    fun classify(callbackUri: String, expectedState: String): GoogleOAuthCallback {
        val query = try {
            URI(callbackUri).rawQuery
        } catch (_: Exception) {
            null
        } ?: return GoogleOAuthCallback.Ignore
        val parameters = query.split('&').mapNotNull { field ->
            val separator = field.indexOf('=')
            if (separator < 0) return@mapNotNull null
            decode(field.substring(0, separator)) to decode(field.substring(separator + 1))
        }.toMap()

        if (parameters["state"] != expectedState) return GoogleOAuthCallback.Ignore
        parameters["error"]?.takeIf(String::isNotBlank)?.let {
            return GoogleOAuthCallback.Denied(it)
        }
        val code = parameters["code"]?.takeIf(String::isNotBlank) ?: return GoogleOAuthCallback.Ignore
        return GoogleOAuthCallback.AuthorizationCode(code)
    }

    private fun decode(value: String): String = try {
        URLDecoder.decode(value, StandardCharsets.UTF_8.name())
    } catch (_: IllegalArgumentException) {
        value
    }
}

sealed interface GoogleBrowserFailure {
    data object UnavailableForBuild : GoogleBrowserFailure
    data class Retryable(val reason: String) : GoogleBrowserFailure
}

object GoogleBrowserFailurePolicy {
    fun classify(code: String, description: String?): GoogleBrowserFailure {
        val normalizedCode = code.trim().lowercase()
        val normalizedDescription = description.orEmpty().lowercase()
        val unavailable = normalizedCode == "invalid_client" ||
            normalizedCode == "redirect_uri_mismatch" ||
            normalizedDescription.contains("redirect_uri_mismatch") ||
            normalizedDescription.contains("custom uri scheme") ||
            normalizedDescription.contains("custom scheme") ||
            normalizedDescription.contains("signature") ||
            normalizedDescription.contains("sha-1")
        return if (unavailable) {
            GoogleBrowserFailure.UnavailableForBuild
        } else {
            GoogleBrowserFailure.Retryable(normalizedCode.ifEmpty { "oauth_failed" })
        }
    }
}
