package app.switchboard.mobile.domain.google

interface GoogleCredentialRepository {
    val bundle: GoogleCredentialBundle?

    fun replace(expected: GoogleCredentialBundle, replacement: GoogleCredentialBundle): Boolean

    fun clearNativeOwned(expected: GoogleCredentialBundle?): Boolean
}

sealed interface GoogleRefreshResult {
    data class Success(
        val accessToken: String,
        val expiresAtEpochMs: Long,
        val email: String? = null,
    ) : GoogleRefreshResult

    data class Failure(val code: String, val detail: String? = null) : GoogleRefreshResult
}

fun interface GoogleTokenExchange {
    fun refresh(credentials: GoogleCredentialBundle, callback: (GoogleRefreshResult) -> Unit)
}

sealed interface GoogleAccessTokenResult {
    data class Available(val accessToken: String) : GoogleAccessTokenResult
    data class RetryableFailure(val reason: String) : GoogleAccessTokenResult
    data object SignedOut : GoogleAccessTokenResult
}

class GoogleTokenCoordinator(
    private val credentials: GoogleCredentialRepository,
    private val exchange: GoogleTokenExchange,
    private val nowEpochMs: () -> Long,
) {
    private val waiting = mutableListOf<(GoogleAccessTokenResult) -> Unit>()
    private var refreshing: GoogleCredentialBundle? = null

    fun requestAccessToken(callback: (GoogleAccessTokenResult) -> Unit) {
        val current = credentials.bundle
        if (current == null) {
            callback(GoogleAccessTokenResult.SignedOut)
            return
        }
        val token = current.accessToken
        val expiry = current.expiresAtEpochMs
        if (token != null && expiry != null && expiry - nowEpochMs() > REFRESH_SKEW_MS) {
            callback(GoogleAccessTokenResult.Available(token))
            return
        }

        waiting += callback
        if (refreshing != null) return
        refreshing = current
        exchange.refresh(current) { result -> completeRefresh(current, result) }
    }

    private fun completeRefresh(expected: GoogleCredentialBundle, result: GoogleRefreshResult) {
        if (refreshing != expected) return
        refreshing = null
        val outcome = when (result) {
            is GoogleRefreshResult.Success -> {
                val replacement = expected.copy(
                    accessToken = result.accessToken,
                    expiresAtEpochMs = result.expiresAtEpochMs,
                    email = result.email ?: expected.email,
                )
                if (credentials.replace(expected, replacement)) {
                    GoogleAccessTokenResult.Available(result.accessToken)
                } else {
                    currentCredentialOutcome()
                }
            }

            is GoogleRefreshResult.Failure -> {
                if (result.code == "invalid_grant") {
                    if (credentials.clearNativeOwned(expected) || credentials.bundle == null) {
                        GoogleAccessTokenResult.SignedOut
                    } else {
                        currentCredentialOutcome()
                    }
                } else {
                    GoogleAccessTokenResult.RetryableFailure(result.code)
                }
            }
        }
        val callbacks = waiting.toList()
        waiting.clear()
        callbacks.forEach { it(outcome) }
    }

    private fun currentCredentialOutcome(): GoogleAccessTokenResult {
        val current = credentials.bundle ?: return GoogleAccessTokenResult.SignedOut
        val token = current.accessToken
        val expiry = current.expiresAtEpochMs
        return if (token != null && expiry != null && expiry - nowEpochMs() > REFRESH_SKEW_MS) {
            GoogleAccessTokenResult.Available(token)
        } else {
            GoogleAccessTokenResult.RetryableFailure("credentials_changed")
        }
    }

    private companion object {
        const val REFRESH_SKEW_MS = 60_000L
    }
}
