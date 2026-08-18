package app.switchboard.mobile.platform.google

import app.switchboard.mobile.domain.google.GoogleCredentialBundle
import java.util.concurrent.atomic.AtomicBoolean

sealed interface GoogleSignOutResult {
    data class SignedOut(val remoteResult: GoogleRemoteRevokeResult) : GoogleSignOutResult
    data object AlreadySignedOut : GoogleSignOutResult
    data object Blocked : GoogleSignOutResult
    data object Superseded : GoogleSignOutResult
    data object LocalClearFailed : GoogleSignOutResult
}

class GoogleSignOutCoordinator(
    private val credentials: GoogleNativeCredentialStore,
    private val transport: GoogleRevokeTransport,
) {
    fun signOut(callback: (GoogleSignOutResult) -> Unit) {
        val expected = when (val status = credentials.readStatus()) {
            GoogleCredentialReadResult.Absent -> {
                callback(GoogleSignOutResult.AlreadySignedOut)
                return
            }
            is GoogleCredentialReadResult.Blocked -> {
                callback(GoogleSignOutResult.Blocked)
                return
            }
            is GoogleCredentialReadResult.Available -> status.credentials
        }
        val request = GoogleRevokeHttpContract.request(expected)
        if (request == null) {
            finish(expected, GoogleRemoteRevokeResult.Skipped, callback)
            return
        }
        val delivered = AtomicBoolean(false)
        fun complete(remote: GoogleRemoteRevokeResult) {
            if (delivered.compareAndSet(false, true)) finish(expected, remote, callback)
        }
        try {
            transport.revoke(request, ::complete)
        } catch (_: Exception) {
            complete(GoogleRemoteRevokeResult.NetworkFailure)
        }
    }

    private fun finish(
        expected: GoogleCredentialBundle,
        remote: GoogleRemoteRevokeResult,
        callback: (GoogleSignOutResult) -> Unit,
    ) {
        if (credentials.clearNativeOwned(expected)) {
            callback(GoogleSignOutResult.SignedOut(remote))
            return
        }
        callback(
            when (val status = credentials.readStatus()) {
                GoogleCredentialReadResult.Absent -> GoogleSignOutResult.SignedOut(remote)
                is GoogleCredentialReadResult.Available -> if (status.credentials != expected) {
                    GoogleSignOutResult.Superseded
                } else {
                    GoogleSignOutResult.LocalClearFailed
                }
                is GoogleCredentialReadResult.Blocked -> GoogleSignOutResult.LocalClearFailed
            },
        )
    }
}
