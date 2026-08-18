package app.switchboard.mobile.platform.google

import app.switchboard.mobile.domain.google.GoogleClientConfig
import app.switchboard.mobile.domain.google.GoogleCredentialBundle
import app.switchboard.mobile.domain.google.GoogleRefreshResult
import app.switchboard.mobile.domain.google.GoogleTokenExchange
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

class GoogleCredentialImportCoordinatorTest {
    @Test
    fun `candidate is activated only after Google refresh and verified persistence`() {
        val store = FakeStore(previous)
        val exchange = FakeExchange()
        val coordinator = GoogleCredentialImportCoordinator(store, exchange)
        var result: GoogleCredentialImportResult? = null

        coordinator.import(json, fallbackClient = null) { result = it }
        assertSame(previous, store.bundle)
        assertNull(store.lastWrite)

        exchange.complete(GoogleRefreshResult.Success("access", 90_000, "person@example.com"))

        assertEquals(GoogleCredentialImportResult.Success("person@example.com"), result)
        assertEquals("1//new", store.bundle?.refreshToken)
        assertEquals("access", store.bundle?.accessToken)
        assertEquals(90_000L, store.bundle?.expiresAtEpochMs)
    }

    @Test
    fun `invalid or rejected candidate leaves the previous identity byte-for-byte`() {
        val store = FakeStore(previous)
        val exchange = FakeExchange()
        val coordinator = GoogleCredentialImportCoordinator(store, exchange)
        var invalid: GoogleCredentialImportResult? = null
        var rejected: GoogleCredentialImportResult? = null

        coordinator.import("not credentials", null) { invalid = it }
        coordinator.import(json, null) { rejected = it }
        exchange.complete(GoogleRefreshResult.Failure("invalid_grant"))

        assertEquals(GoogleCredentialImportResult.InvalidInput, invalid)
        assertEquals(GoogleCredentialImportResult.VerificationFailed("invalid_grant"), rejected)
        assertSame(previous, store.bundle)
        assertNull(store.lastWrite)
    }

    @Test
    fun `new import supersedes a late older refresh`() {
        val store = FakeStore(previous)
        val exchange = FakeExchange()
        val coordinator = GoogleCredentialImportCoordinator(store, exchange)
        val results = mutableListOf<GoogleCredentialImportResult>()

        coordinator.import(json.replace("1//new", "1//old-attempt"), null, results::add)
        coordinator.import(json, null, results::add)
        exchange.completeAt(0, GoogleRefreshResult.Success("stale", 10_000))
        exchange.completeAt(1, GoogleRefreshResult.Success("fresh", 20_000))

        assertEquals(
            listOf(
                GoogleCredentialImportResult.Superseded,
                GoogleCredentialImportResult.Success(null),
            ),
            results,
        )
        assertEquals("1//new", store.bundle?.refreshToken)
        assertEquals("fresh", store.bundle?.accessToken)
    }

    @Test
    fun `bare refresh token requires the canonical local client`() {
        val store = FakeStore(null)
        val exchange = FakeExchange()
        val coordinator = GoogleCredentialImportCoordinator(store, exchange)

        coordinator.import("1//bare", GoogleClientConfig("canonical-client")) {}

        assertEquals("canonical-client", exchange.requests.single().clientId)
    }

    private class FakeExchange : GoogleTokenExchange {
        val requests = mutableListOf<GoogleCredentialBundle>()
        private val callbacks = mutableListOf<(GoogleRefreshResult) -> Unit>()

        override fun refresh(credentials: GoogleCredentialBundle, callback: (GoogleRefreshResult) -> Unit) {
            requests += credentials
            callbacks += callback
        }

        fun complete(result: GoogleRefreshResult) = completeAt(callbacks.lastIndex, result)

        fun completeAt(index: Int, result: GoogleRefreshResult) = callbacks[index](result)
    }

    private class FakeStore(initial: GoogleCredentialBundle?) : GoogleNativeCredentialStore {
        override var bundle: GoogleCredentialBundle? = initial
        var lastWrite: GoogleCredentialBundle? = null

        override fun readStatus(): GoogleCredentialReadResult = bundle?.let(GoogleCredentialReadResult::Available)
            ?: GoogleCredentialReadResult.Absent

        override fun writeAndVerify(credentials: GoogleCredentialBundle): GoogleCredentialWriteResult {
            lastWrite = credentials
            bundle = credentials
            return GoogleCredentialWriteResult.Verified
        }

        override fun replace(expected: GoogleCredentialBundle, replacement: GoogleCredentialBundle): Boolean = false

        override fun clearNativeOwned(expected: GoogleCredentialBundle?): Boolean = false
    }

    private companion object {
        val previous = GoogleCredentialBundle("old-client", refreshToken = "1//previous", accessToken = "old")
        const val json = """{"clientId":"new-client","refreshToken":"1//new"}"""
    }
}
