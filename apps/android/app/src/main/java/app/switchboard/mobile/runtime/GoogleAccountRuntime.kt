package app.switchboard.mobile.runtime

import app.switchboard.mobile.AppContract
import app.switchboard.mobile.domain.google.GoogleClientConfig
import app.switchboard.mobile.domain.google.GoogleTokenExchange
import app.switchboard.mobile.platform.google.GoogleAccountPresentation
import app.switchboard.mobile.platform.google.GoogleAccountPresenter
import app.switchboard.mobile.platform.google.GoogleCredentialImportCoordinator
import app.switchboard.mobile.platform.google.GoogleCredentialImportResult
import app.switchboard.mobile.platform.google.GoogleNativeCredentialStore
import app.switchboard.mobile.platform.google.GoogleRevokeTransport
import app.switchboard.mobile.platform.google.GoogleSignOutCoordinator
import app.switchboard.mobile.platform.google.GoogleSignOutResult
import java.io.Closeable
import kotlin.coroutines.resume
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.suspendCancellableCoroutine

class GoogleAccountRuntime(
    private val store: GoogleNativeCredentialStore,
    exchange: GoogleTokenExchange,
    revoke: GoogleRevokeTransport,
    private val fallbackClient: GoogleClientConfig = GoogleClientConfig(
        clientId = AppContract.GOOGLE_OAUTH_CLIENT_ID,
        clientSecret = AppContract.GOOGLE_OAUTH_CLIENT_SECRET,
    ),
) : Closeable {
    private val importer = GoogleCredentialImportCoordinator(store, exchange)
    private val signerOut = GoogleSignOutCoordinator(store, revoke)
    private val mutablePresentation = MutableStateFlow(readPresentation())

    val presentation: StateFlow<GoogleAccountPresentation> = mutablePresentation.asStateFlow()

    fun refresh() {
        mutablePresentation.value = readPresentation()
    }

    suspend fun importCredentials(raw: String): GoogleCredentialImportResult =
        suspendCancellableCoroutine { continuation ->
            importer.import(raw, fallbackClient) { result ->
                refresh()
                if (continuation.isActive) continuation.resume(result)
            }
            continuation.invokeOnCancellation { importer.cancel() }
        }

    suspend fun signOut(): GoogleSignOutResult = suspendCancellableCoroutine { continuation ->
        signerOut.signOut { result ->
            refresh()
            if (continuation.isActive) continuation.resume(result)
        }
    }

    override fun close() {
        importer.cancel()
    }

    private fun readPresentation(): GoogleAccountPresentation =
        GoogleAccountPresenter.present(store.readStatus())
}
