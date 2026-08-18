package app.switchboard.mobile.platform.deeplink

import app.switchboard.mobile.AppContract
import app.switchboard.mobile.domain.google.GoogleOAuthCallback
import app.switchboard.mobile.domain.google.GoogleOAuthCallbackPolicy
import java.net.URI

enum class RegisteredDeepLink {
    AppScheme,
    GoogleOAuthCallback,
    Ignore,
}

object SwitchboardDeepLinkContract {
    val AppScheme: String = AppContract.DEEP_LINK_SCHEMES[0]
    val GoogleOAuthScheme: String = AppContract.DEEP_LINK_SCHEMES[1]

    fun classify(uriString: String): RegisteredDeepLink {
        val uri = runCatching { URI(uriString) }.getOrNull() ?: return RegisteredDeepLink.Ignore
        return when (uri.scheme) {
            AppScheme -> RegisteredDeepLink.AppScheme
            GoogleOAuthScheme -> if (uri.hasExactOAuthRedirectPath()) {
                RegisteredDeepLink.GoogleOAuthCallback
            } else {
                RegisteredDeepLink.Ignore
            }
            else -> RegisteredDeepLink.Ignore
        }
    }

    private fun URI.hasExactOAuthRedirectPath(): Boolean =
        (rawAuthority == null && rawPath == "/oauth2redirect") ||
            (rawAuthority == "oauth2redirect" && rawPath.orEmpty().isEmpty())
}

class GoogleOAuthAttempt internal constructor(
    internal val generation: Long,
)

class GoogleOAuthDeepLinkFence {
    private data class ActiveAttempt(
        val generation: Long,
        val expectedState: String,
    )

    private var nextGeneration = 0L
    private var active: ActiveAttempt? = null

    @Synchronized
    fun begin(expectedState: String): GoogleOAuthAttempt {
        val attempt = ActiveAttempt(++nextGeneration, expectedState)
        active = attempt
        return GoogleOAuthAttempt(attempt.generation)
    }

    @Synchronized
    fun accept(attempt: GoogleOAuthAttempt, uri: String): GoogleOAuthCallback {
        val expected = active?.takeIf { it.generation == attempt.generation }
            ?: return GoogleOAuthCallback.Ignore
        if (
            SwitchboardDeepLinkContract.classify(uri) !=
            RegisteredDeepLink.GoogleOAuthCallback
        ) {
            return GoogleOAuthCallback.Ignore
        }
        return GoogleOAuthCallbackPolicy.classify(uri, expected.expectedState).also { result ->
            if (result !is GoogleOAuthCallback.Ignore && active?.generation == attempt.generation) {
                active = null
            }
        }
    }

    @Synchronized
    fun cancel(attempt: GoogleOAuthAttempt) {
        if (active?.generation == attempt.generation) active = null
    }
}
