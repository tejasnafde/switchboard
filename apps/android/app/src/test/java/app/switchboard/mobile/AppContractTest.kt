package app.switchboard.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AppContractTest {
    @Test
    fun `canonical Google OAuth client is public and matches the registered redirect scheme`() {
        assertEquals(
            "974343814740-be31f3e59stdql81uke54r62aodb5c7q.apps.googleusercontent.com",
            AppContract.GOOGLE_OAUTH_CLIENT_ID,
        )
        assertEquals(null, AppContract.GOOGLE_OAUTH_CLIENT_SECRET)
        assertEquals(
            "com.googleusercontent.apps.974343814740-be31f3e59stdql81uke54r62aodb5c7q",
            AppContract.GOOGLE_OAUTH_REDIRECT_SCHEME,
        )
        assertTrue(AppContract.DEEP_LINK_SCHEMES.contains(AppContract.GOOGLE_OAUTH_REDIRECT_SCHEME))
    }

    @Test
    fun releaseIdentityMatchesTheInstalledReactNativeApp() {
        assertEquals("app.switchboard.mobile", AppContract.RELEASE_APPLICATION_ID)
        assertEquals(".native.dev", AppContract.DEBUG_APPLICATION_ID_SUFFIX)
        assertEquals("0.5.0", AppContract.VERSION_NAME)
        assertEquals(2, AppContract.VERSION_CODE)
    }

    @Test
    fun notificationAndDeepLinkIdentitiesRemainStable() {
        assertEquals("switchboard-agents", AppContract.NOTIFICATION_CHANNEL_ID)
        assertEquals("Agent activity", AppContract.NOTIFICATION_CHANNEL_NAME)
        assertEquals(
            listOf(
                "switchboard",
                "com.googleusercontent.apps.974343814740-be31f3e59stdql81uke54r62aodb5c7q",
            ),
            AppContract.DEEP_LINK_SCHEMES,
        )
    }
}
