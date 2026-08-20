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

enum class AppDeepLinkRoute {
    Settings,
}

data class PendingAppDeepLink(
    val requestId: Long,
    val route: AppDeepLinkRoute,
)

data class DeepLinkAuditFields(
    val scheme: String?,
    val authority: String?,
    val path: String?,
)

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

    fun appRoute(uriString: String): AppDeepLinkRoute? {
        val uri = runCatching { URI(uriString) }.getOrNull() ?: return null
        if (uri.scheme != AppScheme || uri.rawQuery != null || uri.rawFragment != null) return null
        if (uri.rawUserInfo != null || uri.port != -1) return null
        return when {
            uri.rawAuthority == "settings" && uri.rawPath.orEmpty().isEmpty() ->
                AppDeepLinkRoute.Settings
            uri.rawAuthority == null && uri.rawPath == "/settings" ->
                AppDeepLinkRoute.Settings
            else -> null
        }
    }

    fun auditFields(uriString: String): DeepLinkAuditFields {
        val uri = runCatching { URI(uriString) }.getOrNull()
            ?: return DeepLinkAuditFields(null, null, null)
        return DeepLinkAuditFields(
            scheme = uri.scheme?.auditValue(),
            authority = uri.host?.auditValue(),
            path = uri.rawPath?.auditValue(),
        )
    }

    private fun String.auditValue(): String =
        filterNot(Char::isISOControl).take(160)

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
