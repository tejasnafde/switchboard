package app.switchboard.mobile.data.connection

import app.switchboard.mobile.platform.migration.CredentialWriteVerification
import app.switchboard.mobile.platform.migration.SelectedCredential
import app.switchboard.mobile.platform.protocol.SessionCredentialStore
import app.switchboard.mobile.platform.storage.NativeCredential
import java.util.UUID

fun interface NativeSessionCredentialObserver {
    fun onCleanupDeferred(connectionId: String)
}

class NativeSessionCredentialStore(
    private val repository: NativeConnectionRepository,
    private val credentials: ConnectionCredentialStore,
    private val credentialKeyFactory: () -> String = { UUID.randomUUID().toString() },
    private val observer: NativeSessionCredentialObserver = NativeSessionCredentialObserver {},
) : SessionCredentialStore {
    private val pendingRetirements = mutableMapOf<String, MutableSet<String>>()

    @Synchronized
    override fun saveAndVerifySession(
        connectionId: String,
        expectedOldRef: String?,
        session: String,
    ): Boolean {
        if (expectedOldRef.isNullOrBlank() || session.isBlank()) return false
        val stored = runCatching { repository.findStored(connectionId) }.getOrNull() ?: return false
        if (stored.activeCredentialKey != expectedOldRef) return false
        val priorCredential = runCatching { credentials.read(expectedOldRef) }.getOrNull() ?: return false
        if (!priorCredential.canMintDeviceSession()) return false

        val newRef = runCatching(credentialKeyFactory).getOrNull() ?: return false
        if (newRef.isBlank() || newRef == expectedOldRef) return false
        val verification = runCatching {
            credentials.writeAndVerify(
                newRef,
                SelectedCredential.DeviceSession(session),
            )
        }.getOrNull()
        if (verification !is CredentialWriteVerification.Verified) {
            deleteNativeOwned(newRef)
            return false
        }

        val replaced = repository.compareAndSwapCredentialRef(
            connectionId,
            expectedOldRef,
            newRef,
        )
        if (!replaced) {
            deleteNativeOwned(newRef)
            return false
        }
        pendingRetirements.getOrPut(connectionId) { linkedSetOf() }.add(expectedOldRef)
        return true
    }

    @Synchronized
    override fun retireLegacyCredentials(connectionId: String) {
        val pending = pendingRetirements[connectionId] ?: return
        val deferred = pending.filterNot(::deleteNativeOwned)
        if (deferred.isEmpty()) {
            pendingRetirements.remove(connectionId)
        } else {
            pending.clear()
            pending.addAll(deferred)
            observer.onCleanupDeferred(connectionId)
        }
    }

    private fun deleteNativeOwned(logicalKey: String): Boolean =
        runCatching { credentials.deleteNativeOwned(logicalKey) }.getOrDefault(false)
}

private fun NativeCredential.canMintDeviceSession(): Boolean = when (kind) {
    NativeCredential.Kind.PAIRING_TOKEN,
    NativeCredential.Kind.LEGACY_INLINE_TOKEN,
    -> true
    NativeCredential.Kind.DEVICE_SESSION -> false
}
