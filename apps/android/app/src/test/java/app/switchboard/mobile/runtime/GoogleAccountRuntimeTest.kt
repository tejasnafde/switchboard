package app.switchboard.mobile.runtime

import app.switchboard.mobile.AppContract
import app.switchboard.mobile.domain.google.GoogleCredentialBundle
import app.switchboard.mobile.domain.google.GoogleRefreshResult
import app.switchboard.mobile.domain.google.GoogleTokenExchange
import app.switchboard.mobile.platform.google.GoogleAccountPresentation
import app.switchboard.mobile.platform.google.GoogleCredentialReadResult
import app.switchboard.mobile.platform.google.GoogleCredentialWriteResult
import app.switchboard.mobile.platform.google.GoogleNativeCredentialStore
import app.switchboard.mobile.platform.google.GoogleRemoteRevokeResult
import app.switchboard.mobile.platform.google.GoogleRevokeTransport
import app.switchboard.mobile.platform.google.GoogleSignOutResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import kotlinx.coroutines.runBlocking

class GoogleAccountRuntimeTest {
    @Test
    fun `bare token import uses canonical public client and publishes verified identity`() = runBlocking {
        val store = FakeStore()
        val exchange = FakeExchange(
            GoogleRefreshResult.Success(
                accessToken = "access-secret",
                expiresAtEpochMs = 90_000,
                email = "person@example.com",
            ),
        )
        val runtime = GoogleAccountRuntime(
            store = store,
            exchange = exchange,
            revoke = FakeRevoke(),
        )

        val result = runtime.importCredentials("1//refresh-secret")

        assertEquals(
            app.switchboard.mobile.platform.google.GoogleCredentialImportResult.Success(
                "person@example.com",
            ),
            result,
        )
        assertEquals(AppContract.GOOGLE_OAUTH_CLIENT_ID, exchange.requests.single().clientId)
        assertNull(exchange.requests.single().clientSecret)
        assertEquals(
            GoogleAccountPresentation.SignedIn("person@example.com"),
            runtime.presentation.value,
        )
        assertFalse(runtime.toString().contains("1//refresh-secret"))
        assertFalse(runtime.presentation.value.toString().contains("access-secret"))
    }

    @Test
    fun `sign out republishes stored state even when remote revoke fails`() = runBlocking {
        val store = FakeStore(credentials())
        val runtime = GoogleAccountRuntime(
            store = store,
            exchange = FakeExchange(GoogleRefreshResult.Failure("unused")),
            revoke = FakeRevoke(GoogleRemoteRevokeResult.NetworkFailure),
        )

        val result = runtime.signOut()

        assertEquals(
            GoogleSignOutResult.SignedOut(GoogleRemoteRevokeResult.NetworkFailure),
            result,
        )
        assertEquals(GoogleAccountPresentation.SignedOut, runtime.presentation.value)
    }

    @Test
    fun `refresh maps blocked storage to fixed presentation without retaining reason`() {
        val store = FakeStore(blockedReason = "token=1//do-not-render")
        val runtime = GoogleAccountRuntime(
            store = store,
            exchange = FakeExchange(GoogleRefreshResult.Failure("unused")),
            revoke = FakeRevoke(),
        )

        runtime.refresh()

        assertEquals(GoogleAccountPresentation.Blocked, runtime.presentation.value)
        assertFalse(runtime.presentation.value.toString().contains("1//do-not-render"))
    }

    private class FakeStore(
        initial: GoogleCredentialBundle? = null,
        private val blockedReason: String? = null,
    ) : GoogleNativeCredentialStore {
        override var bundle: GoogleCredentialBundle? = initial

        override fun readStatus(): GoogleCredentialReadResult = blockedReason?.let {
            GoogleCredentialReadResult.Blocked(it)
        } ?: bundle?.let(GoogleCredentialReadResult::Available)
            ?: GoogleCredentialReadResult.Absent

        override fun writeAndVerify(credentials: GoogleCredentialBundle): GoogleCredentialWriteResult {
            bundle = credentials
            return GoogleCredentialWriteResult.Verified
        }

        override fun replace(
            expected: GoogleCredentialBundle,
            replacement: GoogleCredentialBundle,
        ): Boolean = if (bundle == expected) {
            bundle = replacement
            true
        } else {
            false
        }

        override fun clearNativeOwned(expected: GoogleCredentialBundle?): Boolean {
            if (expected != null && bundle != expected) return false
            bundle = null
            return true
        }
    }

    private class FakeExchange(
        private val result: GoogleRefreshResult,
    ) : GoogleTokenExchange {
        val requests = mutableListOf<GoogleCredentialBundle>()

        override fun refresh(
            credentials: GoogleCredentialBundle,
            callback: (GoogleRefreshResult) -> Unit,
        ) {
            requests += credentials
            callback(result)
        }
    }

    private class FakeRevoke(
        private val result: GoogleRemoteRevokeResult = GoogleRemoteRevokeResult.Revoked,
    ) : GoogleRevokeTransport {
        override fun revoke(
            request: app.switchboard.mobile.platform.google.GoogleRevokeHttpRequest,
            callback: (GoogleRemoteRevokeResult) -> Unit,
        ) = callback(result)
    }

    private fun credentials() = GoogleCredentialBundle(
        clientId = AppContract.GOOGLE_OAUTH_CLIENT_ID,
        refreshToken = "1//refresh",
        accessToken = "access",
        email = "person@example.com",
    )
}
