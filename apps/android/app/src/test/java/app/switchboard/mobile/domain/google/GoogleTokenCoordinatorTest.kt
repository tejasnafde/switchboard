package app.switchboard.mobile.domain.google

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class GoogleTokenCoordinatorTest {
    @Test
    fun `token-bearing result diagnostics are redacted`() {
        assertFalse(GoogleAccessTokenResult.Available("access-secret").toString().contains("access-secret"))
        assertFalse(
            GoogleRefreshResult.Success("refresh-secret", 123L)
                .toString()
                .contains("refresh-secret"),
        )
    }

    @Test
    fun `fresh access token is returned without refresh and near-expiry callers share one refresh`() {
        val store = FakeStore(
            GoogleCredentialBundle(
                clientId = "client",
                refreshToken = "1//refresh",
                accessToken = "fresh",
                expiresAtEpochMs = 200_000,
            ),
        )
        val exchange = FakeExchange()
        val coordinator = GoogleTokenCoordinator(store, exchange, nowEpochMs = { 100_000 })
        val fresh = mutableListOf<GoogleAccessTokenResult>()

        coordinator.requestAccessToken(fresh::add)
        assertEquals(listOf(GoogleAccessTokenResult.Available("fresh")), fresh)
        assertEquals(0, exchange.calls.size)

        store.bundle = store.bundle?.copy(expiresAtEpochMs = 150_000)
        val first = mutableListOf<GoogleAccessTokenResult>()
        val second = mutableListOf<GoogleAccessTokenResult>()
        coordinator.requestAccessToken(first::add)
        coordinator.requestAccessToken(second::add)

        assertEquals(1, exchange.calls.size)
        exchange.complete(
            GoogleRefreshResult.Success(
                accessToken = "replacement",
                expiresAtEpochMs = 300_000,
                email = "person@example.com",
            ),
        )
        assertEquals(listOf(GoogleAccessTokenResult.Available("replacement")), first)
        assertEquals(listOf(GoogleAccessTokenResult.Available("replacement")), second)
        assertEquals("replacement", store.bundle?.accessToken)
    }

    @Test
    fun `invalid grant clears native state once and never refresh-loops`() {
        val store = FakeStore(credentials())
        val exchange = FakeExchange()
        val coordinator = GoogleTokenCoordinator(store, exchange, nowEpochMs = { 100_000 })
        val first = mutableListOf<GoogleAccessTokenResult>()

        coordinator.requestAccessToken(first::add)
        exchange.complete(GoogleRefreshResult.Failure("invalid_grant", "revoked"))

        assertEquals(listOf(GoogleAccessTokenResult.SignedOut), first)
        assertEquals(1, store.clearCalls)
        assertNull(store.bundle)

        val retry = mutableListOf<GoogleAccessTokenResult>()
        coordinator.requestAccessToken(retry::add)
        assertEquals(listOf(GoogleAccessTokenResult.SignedOut), retry)
        assertEquals(1, exchange.calls.size)
        assertEquals(1, store.clearCalls)
    }

    @Test
    fun `transient refresh failure keeps refresh credentials and is retryable`() {
        val original = credentials()
        val store = FakeStore(original)
        val exchange = FakeExchange()
        val coordinator = GoogleTokenCoordinator(store, exchange, nowEpochMs = { 100_000 })
        val results = mutableListOf<GoogleAccessTokenResult>()

        coordinator.requestAccessToken(results::add)
        exchange.complete(GoogleRefreshResult.Failure("temporarily_unavailable", "retry"))

        assertEquals(
            listOf(GoogleAccessTokenResult.RetryableFailure("temporarily_unavailable")),
            results,
        )
        assertEquals(original, store.bundle)
        assertEquals(0, store.clearCalls)
    }

    private fun credentials() = GoogleCredentialBundle(
        clientId = "client",
        refreshToken = "1//refresh",
    )

    private class FakeStore(
        override var bundle: GoogleCredentialBundle?,
    ) : GoogleCredentialRepository {
        var clearCalls = 0

        override fun replace(expected: GoogleCredentialBundle, replacement: GoogleCredentialBundle): Boolean {
            if (bundle != expected) return false
            bundle = replacement
            return true
        }

        override fun clearNativeOwned(expected: GoogleCredentialBundle?): Boolean {
            clearCalls++
            if (expected != null && bundle != expected) return false
            bundle = null
            return true
        }
    }

    private class FakeExchange : GoogleTokenExchange {
        data class Call(
            val credentials: GoogleCredentialBundle,
            val callback: (GoogleRefreshResult) -> Unit,
        )

        val calls = mutableListOf<Call>()

        override fun refresh(
            credentials: GoogleCredentialBundle,
            callback: (GoogleRefreshResult) -> Unit,
        ) {
            calls += Call(credentials, callback)
        }

        fun complete(result: GoogleRefreshResult) = calls.last().callback(result)
    }
}
