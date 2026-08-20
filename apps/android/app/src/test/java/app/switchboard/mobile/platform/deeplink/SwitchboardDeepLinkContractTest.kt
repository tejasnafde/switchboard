package app.switchboard.mobile.platform.deeplink

import app.switchboard.mobile.domain.google.GoogleOAuthCallback
import org.junit.Assert.assertEquals
import org.junit.Test

class SwitchboardDeepLinkContractTest {
    @Test
    fun `audit fields never retain OAuth query credentials or fragments`() {
        val scheme = SwitchboardDeepLinkContract.GoogleOAuthScheme

        assertEquals(
            DeepLinkAuditFields(
                scheme = scheme,
                authority = null,
                path = "/oauth2redirect",
            ),
            SwitchboardDeepLinkContract.auditFields(
                "$scheme:/oauth2redirect?code=secret-code&state=secret-state#secret-fragment",
            ),
        )
    }

    @Test
    fun `only the two registered schemes are recognized without inventing app routes`() {
        assertEquals(
            RegisteredDeepLink.AppScheme,
            SwitchboardDeepLinkContract.classify("switchboard://thread/should-not-be-routed"),
        )
        assertEquals(
            RegisteredDeepLink.Ignore,
            SwitchboardDeepLinkContract.classify("switchboard-lookalike://oauth2redirect"),
        )
        assertEquals(
            RegisteredDeepLink.Ignore,
            SwitchboardDeepLinkContract.classify("https://example.com/thread/1"),
        )
    }

    @Test
    fun `settings is the only exact app route and carries no untrusted parameters`() {
        assertEquals(
            AppDeepLinkRoute.Settings,
            SwitchboardDeepLinkContract.appRoute("switchboard://settings"),
        )
        assertEquals(
            AppDeepLinkRoute.Settings,
            SwitchboardDeepLinkContract.appRoute("switchboard:/settings"),
        )
        assertEquals(
            null,
            SwitchboardDeepLinkContract.appRoute("switchboard://settings/extra"),
        )
        assertEquals(
            null,
            SwitchboardDeepLinkContract.appRoute("switchboard://settings?tab=providers"),
        )
        assertEquals(
            null,
            SwitchboardDeepLinkContract.appRoute("switchboard://thread/thread-1"),
        )
        assertEquals(
            null,
            SwitchboardDeepLinkContract.appRoute("https://settings"),
        )
    }

    @Test
    fun `google callback accepts Android slash variants only at the exact callback path`() {
        val scheme = SwitchboardDeepLinkContract.GoogleOAuthScheme
        assertEquals(
            RegisteredDeepLink.GoogleOAuthCallback,
            SwitchboardDeepLinkContract.classify("$scheme:/oauth2redirect?code=a&state=s"),
        )
        assertEquals(
            RegisteredDeepLink.GoogleOAuthCallback,
            SwitchboardDeepLinkContract.classify("$scheme://oauth2redirect?code=a&state=s"),
        )
        assertEquals(
            RegisteredDeepLink.Ignore,
            SwitchboardDeepLinkContract.classify("$scheme:/wrong?code=a&state=s"),
        )
        assertEquals(
            RegisteredDeepLink.Ignore,
            SwitchboardDeepLinkContract.classify("$scheme://oauth2redirect/extra?code=a&state=s"),
        )
    }

    @Test
    fun `intent adapter accepts only action view with nonblank data`() {
        val callback = "${SwitchboardDeepLinkContract.GoogleOAuthScheme}:/oauth2redirect?code=a&state=s"
        assertEquals(
            callback,
            AndroidDeepLinkIntentAdapter.dataString("android.intent.action.VIEW", callback),
        )
        assertEquals(null, AndroidDeepLinkIntentAdapter.dataString("android.intent.action.SEND", callback))
        assertEquals(null, AndroidDeepLinkIntentAdapter.dataString("android.intent.action.VIEW", "  "))
        assertEquals(null, AndroidDeepLinkIntentAdapter.dataString(null, callback))
    }

    @Test
    fun `newer OAuth attempt fences stale callback and terminal callback is single use`() {
        val fence = GoogleOAuthDeepLinkFence()
        val stale = fence.begin(expectedState = "old-state")
        val current = fence.begin(expectedState = "new-state")
        val scheme = SwitchboardDeepLinkContract.GoogleOAuthScheme

        assertEquals(
            GoogleOAuthCallback.Ignore,
            fence.accept(stale, "$scheme:/oauth2redirect?code=old-code&state=old-state"),
        )
        assertEquals(
            GoogleOAuthCallback.Ignore,
            fence.accept(current, "$scheme:/oauth2redirect?code=forged&state=wrong"),
        )
        assertEquals(
            GoogleOAuthCallback.AuthorizationCode("new/code"),
            fence.accept(current, "$scheme:/oauth2redirect?code=new%2Fcode&state=new-state"),
        )
        assertEquals(
            GoogleOAuthCallback.Ignore,
            fence.accept(current, "$scheme:/oauth2redirect?code=duplicate&state=new-state"),
        )
    }

    @Test
    fun `matching denial is terminal while wrong scheme cannot consume attempt`() {
        val fence = GoogleOAuthDeepLinkFence()
        val attempt = fence.begin(expectedState = "expected")
        val scheme = SwitchboardDeepLinkContract.GoogleOAuthScheme

        assertEquals(
            GoogleOAuthCallback.Ignore,
            fence.accept(attempt, "switchboard:/oauth2redirect?error=access_denied&state=expected"),
        )
        assertEquals(
            GoogleOAuthCallback.Denied("access_denied"),
            fence.accept(attempt, "$scheme:/oauth2redirect?error=access_denied&state=expected"),
        )
        assertEquals(
            GoogleOAuthCallback.Ignore,
            fence.accept(attempt, "$scheme:/oauth2redirect?code=late&state=expected"),
        )
    }
}
