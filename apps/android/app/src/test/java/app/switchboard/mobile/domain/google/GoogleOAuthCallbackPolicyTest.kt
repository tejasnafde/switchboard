package app.switchboard.mobile.domain.google

import org.junit.Assert.assertEquals
import org.junit.Test

class GoogleOAuthCallbackPolicyTest {
    @Test
    fun `only an exact state can complete browser authorization`() {
        assertEquals(
            GoogleOAuthCallback.AuthorizationCode("auth-code"),
            GoogleOAuthCallbackPolicy.classify(
                "com.googleusercontent.apps.client:/oauth2redirect?code=auth-code&state=expected",
                expectedState = "expected",
            ),
        )
        assertEquals(
            GoogleOAuthCallback.Ignore,
            GoogleOAuthCallbackPolicy.classify(
                "com.googleusercontent.apps.client:/oauth2redirect?code=forged&state=wrong",
                expectedState = "expected",
            ),
        )
        assertEquals(
            GoogleOAuthCallback.Ignore,
            GoogleOAuthCallbackPolicy.classify(
                "com.googleusercontent.apps.client:/oauth2redirect?code=missing-state",
                expectedState = "expected",
            ),
        )
    }

    @Test
    fun `a matching-state denial is surfaced while a forged denial is ignored`() {
        assertEquals(
            GoogleOAuthCallback.Denied("access_denied"),
            GoogleOAuthCallbackPolicy.classify(
                "com.googleusercontent.apps.client:/oauth2redirect?error=access_denied&state=expected",
                expectedState = "expected",
            ),
        )
        assertEquals(
            GoogleOAuthCallback.Ignore,
            GoogleOAuthCallbackPolicy.classify(
                "com.googleusercontent.apps.client:/oauth2redirect?error=access_denied&state=wrong",
                expectedState = "expected",
            ),
        )
    }

    @Test
    fun `known Android client incompatibilities retain QR as a recovery path`() {
        assertEquals(
            GoogleBrowserFailure.UnavailableForBuild,
            GoogleBrowserFailurePolicy.classify("invalid_client", "The OAuth client was not found"),
        )
        assertEquals(
            GoogleBrowserFailure.UnavailableForBuild,
            GoogleBrowserFailurePolicy.classify(
                "invalid_request",
                "Custom URI scheme is not enabled for your Android client",
            ),
        )
        assertEquals(
            GoogleBrowserFailure.Retryable("temporarily_unavailable"),
            GoogleBrowserFailurePolicy.classify("temporarily_unavailable", null),
        )
    }
}
