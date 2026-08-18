package app.switchboard.mobile.platform.iap

import app.switchboard.mobile.domain.google.GoogleAccessTokenResult
import app.switchboard.mobile.domain.google.GoogleCredentialBundle
import app.switchboard.mobile.platform.google.GoogleCredentialReadResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GoogleIapAccessTokenProviderTest {
    @Test
    fun `signed-out and unreadable stores are typed failures without requesting refresh`() {
        var requests = 0
        var status: GoogleCredentialReadResult = GoogleCredentialReadResult.Absent
        val provider = GoogleIapAccessTokenProvider(
            readCredentials = { status },
            requestGoogleToken = {
                requests++
                it(GoogleAccessTokenResult.Available("should-not-run"))
            },
        )
        val results = mutableListOf<IapAccessTokenResult>()

        provider.request(results::add)
        status = GoogleCredentialReadResult.Blocked("secret-bearing platform detail")
        provider.request(results::add)

        assertEquals(
            listOf(IapAccessTokenResult.SignedOut, IapAccessTokenResult.Blocked),
            results,
        )
        assertEquals(0, requests)
        assertFalse(results.toString().contains("secret-bearing"))
    }

    @Test
    fun `coordinator outcomes map to available retryable and signed-out IAP results`() {
        val callbacks = mutableListOf<(GoogleAccessTokenResult) -> Unit>()
        val provider = GoogleIapAccessTokenProvider(
            readCredentials = {
                GoogleCredentialReadResult.Available(
                    GoogleCredentialBundle("client", refreshToken = "refresh"),
                )
            },
            requestGoogleToken = { callbacks += it },
        )
        val results = mutableListOf<IapAccessTokenResult>()

        provider.request(results::add)
        callbacks.removeAt(0)(GoogleAccessTokenResult.Available("access"))
        provider.request(results::add)
        callbacks.removeAt(0)(GoogleAccessTokenResult.RetryableFailure("network"))
        provider.request(results::add)
        callbacks.removeAt(0)(GoogleAccessTokenResult.SignedOut)

        assertEquals(
            listOf(
                IapAccessTokenResult.Available("access"),
                IapAccessTokenResult.RetryableFailure("network"),
                IapAccessTokenResult.SignedOut,
            ),
            results,
        )
    }

    @Test
    fun `cancellation fences a late coordinator result`() {
        lateinit var completion: (GoogleAccessTokenResult) -> Unit
        val provider = GoogleIapAccessTokenProvider(
            readCredentials = {
                GoogleCredentialReadResult.Available(
                    GoogleCredentialBundle("client", refreshToken = "refresh"),
                )
            },
            requestGoogleToken = { completion = it },
        )
        val results = mutableListOf<IapAccessTokenResult>()

        val request = provider.request(results::add)
        request.cancel()
        completion(GoogleAccessTokenResult.Available("late"))

        assertTrue(results.isEmpty())
    }
}
