package app.switchboard.mobile.platform.google

import app.switchboard.mobile.domain.google.GoogleClientConfig
import app.switchboard.mobile.domain.google.GoogleCredentialBundle
import app.switchboard.mobile.domain.google.GoogleCredentialImport
import app.switchboard.mobile.domain.google.GoogleRefreshResult
import app.switchboard.mobile.domain.google.GoogleTokenExchange

sealed interface GoogleCredentialImportResult {
    data class Success(val email: String?) : GoogleCredentialImportResult
    data object InvalidInput : GoogleCredentialImportResult
    data class VerificationFailed(val reason: String) : GoogleCredentialImportResult
    data object PersistenceFailed : GoogleCredentialImportResult
    data object Superseded : GoogleCredentialImportResult
    data object Cancelled : GoogleCredentialImportResult
}

class GoogleCredentialImportCoordinator(
    private val store: GoogleNativeCredentialStore,
    private val exchange: GoogleTokenExchange,
) {
    private data class Attempt(
        val generation: Long,
        val candidate: GoogleCredentialBundle,
        val callback: (GoogleCredentialImportResult) -> Unit,
    )

    private var nextGeneration = 0L
    private var active: Attempt? = null

    fun import(
        raw: String,
        fallbackClient: GoogleClientConfig?,
        callback: (GoogleCredentialImportResult) -> Unit,
    ) {
        val candidate = GoogleCredentialImport.parse(raw, fallbackClient)
        if (candidate == null) {
            callback(GoogleCredentialImportResult.InvalidInput)
            return
        }
        val (attempt, superseded) = synchronized(this) {
            val prior = active
            val next = Attempt(++nextGeneration, candidate, callback)
            active = next
            next to prior
        }
        superseded?.callback?.invoke(GoogleCredentialImportResult.Superseded)
        exchange.refresh(attempt.candidate) { result -> complete(attempt.generation, result) }
    }

    fun cancel() {
        val cancelled = synchronized(this) {
            active.also { active = null }
        }
        cancelled?.callback?.invoke(GoogleCredentialImportResult.Cancelled)
    }

    private fun complete(generation: Long, refresh: GoogleRefreshResult) {
        val attempt = synchronized(this) {
            active?.takeIf { it.generation == generation }?.also { active = null }
        } ?: return
        val result = when (refresh) {
            is GoogleRefreshResult.Failure ->
                GoogleCredentialImportResult.VerificationFailed(refresh.code)

            is GoogleRefreshResult.Success -> {
                val verified = attempt.candidate.copy(
                    accessToken = refresh.accessToken,
                    expiresAtEpochMs = refresh.expiresAtEpochMs,
                    email = refresh.email,
                )
                when (store.writeAndVerify(verified)) {
                    GoogleCredentialWriteResult.Verified ->
                        GoogleCredentialImportResult.Success(refresh.email)
                    is GoogleCredentialWriteResult.Failed ->
                        GoogleCredentialImportResult.PersistenceFailed
                }
            }
        }
        attempt.callback(result)
    }
}
