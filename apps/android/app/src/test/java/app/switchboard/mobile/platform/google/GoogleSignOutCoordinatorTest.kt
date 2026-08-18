package app.switchboard.mobile.platform.google

import app.switchboard.mobile.domain.google.GoogleCredentialBundle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class GoogleSignOutCoordinatorTest {
    @Test
    fun `revoke contract posts only the preferred refresh token to the exact endpoint`() {
        val credentials = credentials(
            refreshToken = "1//refresh-secret",
            accessToken = "access-secret",
        )

        val request = GoogleRevokeHttpContract.request(credentials)!!

        assertEquals("https://oauth2.googleapis.com/revoke", request.url)
        assertEquals(linkedMapOf("token" to "1//refresh-secret"), request.formFields())
        assertFalse(request.toString().contains("1//refresh-secret"))
        assertFalse(request.toString().contains("access-secret"))
    }

    @Test
    fun `revoke contract falls back to access token only when refresh token is unusable`() {
        val request = GoogleRevokeHttpContract.request(
            credentials(refreshToken = "  ", accessToken = " access-only "),
        )!!

        assertEquals(linkedMapOf("token" to "access-only"), request.formFields())
        assertEquals(
            null,
            GoogleRevokeHttpContract.request(credentials(refreshToken = " ", accessToken = " ")),
        )
    }

    @Test
    fun `response decoder distinguishes accepted HTTP and domain failures`() {
        assertSame(
            GoogleRemoteRevokeResult.Revoked,
            GoogleRevokeHttpContract.decode(200, ""),
        )
        assertSame(
            GoogleRemoteRevokeResult.Rejected,
            GoogleRevokeHttpContract.decode(200, """{"error":"invalid_token"}"""),
        )
        assertEquals(
            GoogleRemoteRevokeResult.HttpFailure(503),
            GoogleRevokeHttpContract.decode(503, "temporarily unavailable"),
        )
        assertSame(
            GoogleRemoteRevokeResult.InvalidResponse,
            GoogleRevokeHttpContract.decode(200, "not-json"),
        )
    }

    @Test
    fun `network revoke failure still compare-and-clears the expected native bundle`() {
        val expected = credentials()
        val store = FakeStore(expected)
        val transport = FakeTransport()
        var result: GoogleSignOutResult? = null
        GoogleSignOutCoordinator(store, transport).signOut { result = it }

        transport.complete(GoogleRemoteRevokeResult.NetworkFailure)

        assertEquals(listOf(expected), store.clearAttempts)
        assertEquals(
            GoogleSignOutResult.SignedOut(GoogleRemoteRevokeResult.NetworkFailure),
            result,
        )
        assertEquals(GoogleCredentialReadResult.Absent, store.readStatus())
    }

    @Test
    fun `late revoke completion cannot clear a newly imported replacement bundle`() {
        val original = credentials(refreshToken = "1//old")
        val replacement = credentials(refreshToken = "1//new", email = "new@example.com")
        val store = FakeStore(original)
        val transport = FakeTransport()
        var result: GoogleSignOutResult? = null
        GoogleSignOutCoordinator(store, transport).signOut { result = it }
        store.current = replacement

        transport.complete(GoogleRemoteRevokeResult.Revoked)

        assertEquals(listOf(original), store.clearAttempts)
        assertEquals(GoogleSignOutResult.Superseded, result)
        assertEquals(GoogleCredentialReadResult.Available(replacement), store.readStatus())
    }

    @Test
    fun `missing revoke token skips HTTP but still clears the captured bundle`() {
        val expected = credentials(refreshToken = " ", accessToken = null)
        val store = FakeStore(expected)
        val transport = FakeTransport()
        var result: GoogleSignOutResult? = null

        GoogleSignOutCoordinator(store, transport).signOut { result = it }

        assertEquals(0, transport.requests.size)
        assertEquals(
            GoogleSignOutResult.SignedOut(GoogleRemoteRevokeResult.Skipped),
            result,
        )
        assertEquals(GoogleCredentialReadResult.Absent, store.readStatus())
    }

    @Test
    fun `account presentation uses fixed copy and never exposes blocked storage detail`() {
        assertEquals(
            GoogleAccountPresentation.SignedOut,
            GoogleAccountPresenter.present(GoogleCredentialReadResult.Absent),
        )
        assertEquals(
            GoogleAccountPresentation.SignedIn("person@example.com"),
            GoogleAccountPresenter.present(
                GoogleCredentialReadResult.Available(credentials(email = "person@example.com")),
            ),
        )
        val blocked = GoogleAccountPresenter.present(
            GoogleCredentialReadResult.Blocked("token=do-not-render"),
        )
        assertEquals(GoogleAccountPresentation.Blocked, blocked)
        assertFalse(blocked.toString().contains("do-not-render"))
    }

    private class FakeTransport : GoogleRevokeTransport {
        val requests = mutableListOf<GoogleRevokeHttpRequest>()
        private var callback: ((GoogleRemoteRevokeResult) -> Unit)? = null

        override fun revoke(
            request: GoogleRevokeHttpRequest,
            callback: (GoogleRemoteRevokeResult) -> Unit,
        ) {
            requests += request
            this.callback = callback
        }

        fun complete(result: GoogleRemoteRevokeResult) = callback!!.invoke(result)
    }

    private class FakeStore(initial: GoogleCredentialBundle?) : GoogleNativeCredentialStore {
        var current = initial
        val clearAttempts = mutableListOf<GoogleCredentialBundle?>()

        override val bundle: GoogleCredentialBundle?
            get() = current

        override fun readStatus(): GoogleCredentialReadResult = current
            ?.let(GoogleCredentialReadResult::Available)
            ?: GoogleCredentialReadResult.Absent

        override fun writeAndVerify(credentials: GoogleCredentialBundle): GoogleCredentialWriteResult {
            current = credentials
            return GoogleCredentialWriteResult.Verified
        }

        override fun replace(
            expected: GoogleCredentialBundle,
            replacement: GoogleCredentialBundle,
        ): Boolean = if (current == expected) {
            current = replacement
            true
        } else {
            false
        }

        override fun clearNativeOwned(expected: GoogleCredentialBundle?): Boolean {
            clearAttempts += expected
            if (expected != null && current != expected) return false
            current = null
            return true
        }
    }

    private fun credentials(
        refreshToken: String = "1//refresh",
        accessToken: String? = "access",
        email: String? = "person@example.com",
    ) = GoogleCredentialBundle(
        clientId = "client",
        clientSecret = "secret",
        refreshToken = refreshToken,
        accessToken = accessToken,
        expiresAtEpochMs = 123_456,
        email = email,
    )
}
