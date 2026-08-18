package app.switchboard.mobile.data.connection

import app.switchboard.mobile.data.local.ConnectionEntity
import app.switchboard.mobile.data.local.NativeCredentialRefEntity
import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.domain.connection.PairingUrl
import app.switchboard.mobile.platform.migration.CredentialWriteVerification
import app.switchboard.mobile.platform.migration.SelectedCredential
import app.switchboard.mobile.platform.storage.NativeCredential
import app.switchboard.mobile.ui.pairing.PairingForm
import app.switchboard.mobile.ui.pairing.PairingSaveIntent
import app.switchboard.mobile.ui.pairing.PairingSaveResult
import app.switchboard.mobile.ui.pairing.PairingSubmission
import java.util.UUID
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext

interface ConnectionDatabase {
    fun find(connectionId: String): StoredConnection?
    fun upsert(connection: ConnectionEntity, activeCredentialKey: String)
    fun compareAndSwapCredentialRef(
        connectionId: String,
        expectedOldRef: String,
        newRef: String,
    ): OfflineSnapshot? = throw UnsupportedOperationException("credential rotation is unavailable")
    fun delete(connectionId: String): Boolean
    fun snapshot(): OfflineSnapshot
}

interface ConnectionCredentialStore {
    fun writeAndVerify(
        logicalKey: String,
        credential: SelectedCredential.Present,
    ): CredentialWriteVerification

    fun read(logicalKey: String): NativeCredential?
    fun deleteNativeOwned(logicalKey: String): Boolean
}

data class StoredConnection(
    val connection: ConnectionEntity,
    val activeCredentialKey: String?,
)

sealed interface ConnectionRemoveResult {
    data object Success : ConnectionRemoveResult
    data class Failure(val message: String) : ConnectionRemoveResult
}

class NativeConnectionRepository(
    private val database: ConnectionDatabase,
    private val credentials: ConnectionCredentialStore,
    private val idFactory: () -> String = { UUID.randomUUID().toString() },
    private val credentialKeyFactory: () -> String = { UUID.randomUUID().toString() },
    private val dispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
    private val mutableSnapshots = MutableStateFlow<OfflineSnapshot?>(null)
    val snapshots = mutableSnapshots.asStateFlow()

    fun seed(snapshot: OfflineSnapshot) {
        mutableSnapshots.value = snapshot
    }

    fun findStored(connectionId: String): StoredConnection? = database.find(connectionId)

    @Synchronized
    fun compareAndSwapCredentialRef(
        connectionId: String,
        expectedOldRef: String,
        newRef: String,
    ): Boolean = try {
        val snapshot = database.compareAndSwapCredentialRef(
            connectionId,
            expectedOldRef,
            newRef,
        ) ?: return false
        val publishedRef = snapshot.nativeCredentialRefs
            .firstOrNull { it.connectionId == connectionId }
            ?.logicalKey
        if (publishedRef != newRef) return false
        mutableSnapshots.value = snapshot
        true
    } catch (_: Exception) {
        false
    }

    fun editForm(connectionId: String): PairingForm? = mutableSnapshots.value
        ?.connections
        ?.firstOrNull { it.id == connectionId && it.kind == WEBSOCKET_KIND }
        ?.let { row ->
            PairingForm(
                label = row.label,
                address = row.url.orEmpty(),
                // Credentials stay in encrypted native storage. An empty field
                // means "preserve" for edits; secrets never enter UI state.
                token = "",
            )
        }

    suspend fun save(intent: PairingSaveIntent): PairingSaveResult = withContext(dispatcher) {
        if (mutableSnapshots.value == null) {
            return@withContext PairingSaveResult.Failure("Machines are still loading. Try again shortly")
        }
        val stored = when (intent) {
            is PairingSaveIntent.Add -> null
            is PairingSaveIntent.Edit -> database.find(intent.connectionId)
                ?: return@withContext PairingSaveResult.Failure("That machine no longer exists")
        }
        val existing = stored?.connection
        val connectionId = existing?.id ?: idFactory()
        val submittedCredential = intent.submission.selectedCredential()
        val priorCredentialKey = stored?.activeCredentialKey
        val priorCredential = priorCredentialKey?.let(credentials::read)

        if (
            existing != null &&
            submittedCredential == null &&
            normalizedEndpoint(existing.url) != normalizedEndpoint(intent.submission.url)
        ) {
            return@withContext PairingSaveResult.Failure(
                "Enter a new pairing code or access token when changing the address",
            )
        }

        if (submittedCredential == null && priorCredential == null) {
            return@withContext PairingSaveResult.Failure("Enter a pairing code or access token")
        }

        if (submittedCredential != null) {
            val newCredentialKey = credentialKeyFactory()
            when (credentials.writeAndVerify(newCredentialKey, submittedCredential)) {
                CredentialWriteVerification.Verified -> Unit
                is CredentialWriteVerification.Failed -> {
                    credentials.deleteNativeOwned(newCredentialKey)
                    return@withContext PairingSaveResult.Failure("Could not save the credential securely")
                }
            }
            val row = intent.submission.toEntity(connectionId, existing)
            try {
                database.upsert(row, newCredentialKey)
            } catch (_: Exception) {
                credentials.deleteNativeOwned(newCredentialKey)
                return@withContext PairingSaveResult.Failure("Could not save the machine")
            }
            if (priorCredentialKey != null && priorCredentialKey != newCredentialKey) {
                credentials.deleteNativeOwned(priorCredentialKey)
            }
            publishSnapshot(row = row, activeCredentialKey = newCredentialKey)
            return@withContext PairingSaveResult.Success
        }

        val activeCredentialKey = requireNotNull(priorCredentialKey)
        val row = intent.submission.toEntity(connectionId, existing)
        try {
            database.upsert(row, activeCredentialKey)
        } catch (_: Exception) {
            return@withContext PairingSaveResult.Failure("Could not save the machine")
        }
        publishSnapshot(row = row, activeCredentialKey = activeCredentialKey)
        PairingSaveResult.Success
    }

    suspend fun remove(connectionId: String): ConnectionRemoveResult = withContext(dispatcher) {
        if (mutableSnapshots.value == null) {
            return@withContext ConnectionRemoveResult.Failure("Machines are still loading")
        }
        val stored = database.find(connectionId) ?: return@withContext ConnectionRemoveResult.Success
        val deleted = try {
            database.delete(connectionId)
        } catch (_: Exception) {
            false
        }
        if (!deleted) return@withContext ConnectionRemoveResult.Failure("Could not remove the machine")

        val credentialKey = stored.activeCredentialKey
        if (credentialKey != null && !credentials.deleteNativeOwned(credentialKey)) {
            // The authoritative row is already gone. The uniquely keyed value
            // may remain orphaned, but can never be mistaken for another
            // connection or selected as active without a Room reference.
            publishSnapshot(removedConnectionId = connectionId)
            return@withContext ConnectionRemoveResult.Failure("The machine was removed; credential cleanup will be retried")
        }

        publishSnapshot(removedConnectionId = connectionId)
        ConnectionRemoveResult.Success
    }

    private fun publishSnapshot(
        row: ConnectionEntity? = null,
        activeCredentialKey: String? = null,
        removedConnectionId: String? = null,
    ) {
        val reread = runCatching(database::snapshot).getOrNull()
        if (reread != null) {
            mutableSnapshots.value = reread
            return
        }
        val current = mutableSnapshots.value ?: return
        val connections = current.connections
            .filterNot { it.id == removedConnectionId || it.id == row?.id }
            .let { remaining -> if (row == null) remaining else remaining + row }
            .sortedBy { it.id }
        val nativeCredentialRefs = current.nativeCredentialRefs
            .filterNot { it.connectionId == removedConnectionId || it.connectionId == row?.id }
            .let { remaining ->
                if (row == null || activeCredentialKey == null) {
                    remaining
                } else {
                    remaining + NativeCredentialRefEntity(row.id, activeCredentialKey)
                }
            }
            .sortedBy { it.connectionId }
        mutableSnapshots.value = current.copy(
            connections = connections,
            nativeCredentialRefs = nativeCredentialRefs,
        )
    }

    private companion object {
        const val WEBSOCKET_KIND = "ws"
    }
}

private fun PairingSubmission.selectedCredential(): SelectedCredential.Present? = when {
    pairing != null -> SelectedCredential.PairingToken(pairing)
    token != null -> SelectedCredential.LegacyInlineToken(token)
    else -> null
}

private fun normalizedEndpoint(value: String?): String? =
    value?.let { PairingUrl.parse(it)?.endpoint ?: it }

private fun PairingSubmission.toEntity(
    connectionId: String,
    existing: ConnectionEntity?,
) = ConnectionEntity(
    id = connectionId,
    label = label,
    kind = "ws",
    url = url,
    project = existing?.project,
    zone = null,
    instance = null,
    port = null,
)
