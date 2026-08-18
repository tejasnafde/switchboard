package app.switchboard.mobile.data.connection

import app.switchboard.mobile.data.local.ConnectionEntity
import app.switchboard.mobile.data.local.NativeCredentialRefEntity
import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.domain.connection.PairingUrl
import app.switchboard.mobile.platform.migration.CredentialWriteVerification
import app.switchboard.mobile.platform.migration.SelectedCredential
import app.switchboard.mobile.platform.storage.NativeCredential
import app.switchboard.mobile.ui.pairing.PairingForm
import app.switchboard.mobile.ui.pairing.PairingConnectionKind
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
    fun compareAndSwapConnection(
        expected: StoredConnection,
        replacement: ConnectionEntity,
        newCredentialRef: String,
    ): OfflineSnapshot? = throw UnsupportedOperationException("connection replacement is unavailable")
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
    private data class EditTicket(val connectionId: String, val generation: Long)

    private sealed interface EditCommit {
        data class Success(val snapshot: OfflineSnapshot) : EditCommit
        data object Stale : EditCommit
        data object Conflict : EditCommit
        data object Failed : EditCommit
    }

    private val mutableSnapshots = MutableStateFlow<OfflineSnapshot?>(null)
    val snapshots = mutableSnapshots.asStateFlow()
    private val editCommitLock = Any()
    private val latestEditGenerations = mutableMapOf<String, Long>()
    private var nextEditGeneration = 0L

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
        ?.firstOrNull { it.id == connectionId }
        ?.let { row ->
            when (row.kind) {
                WEBSOCKET_KIND -> PairingForm(
                    kind = PairingConnectionKind.WEBSOCKET,
                    label = row.label,
                    address = row.url.orEmpty(),
                    // Credentials stay in encrypted native storage. An empty field
                    // means "preserve" for edits; secrets never enter UI state.
                    token = "",
                )
                IAP_KIND -> PairingForm(
                    kind = PairingConnectionKind.IAP,
                    label = row.label,
                    project = row.project.orEmpty(),
                    zone = row.zone.orEmpty(),
                    instance = row.instance.orEmpty(),
                    port = row.port?.toString().orEmpty(),
                    token = "",
                )
                else -> null
            }
        }

    suspend fun save(intent: PairingSaveIntent): PairingSaveResult {
        val editTicket = beginEdit(intent)
        return withContext(dispatcher) {
        if (mutableSnapshots.value == null) {
            return@withContext PairingSaveResult.Failure("Machines are still loading. Try again shortly")
        }
        val submission = intent.submission.normalizedForPersistence()
            ?: return@withContext PairingSaveResult.Failure("Check the machine details and try again")
        val stored = try {
            when (intent) {
                is PairingSaveIntent.Add -> null
                is PairingSaveIntent.Edit -> database.find(intent.connectionId)
                    ?: return@withContext PairingSaveResult.Failure("That machine no longer exists")
            }
        } catch (_: Exception) {
            return@withContext PairingSaveResult.Failure("Could not load the machine")
        }
        val existing = stored?.connection
        val connectionId = existing?.id ?: idFactory()
        val submittedCredential = submission.selectedCredential()
        val priorCredentialKey = stored?.activeCredentialKey
        val priorCredential = try {
            priorCredentialKey?.let(credentials::read)
        } catch (_: Exception) {
            return@withContext PairingSaveResult.Failure("Could not read the saved credential")
        }

        if (existing != null && existing.kind != submission.kind.storageValue) {
            return@withContext PairingSaveResult.Failure(
                "Remove this machine and add it again to change the connection type",
            )
        }

        if (
            existing != null &&
            submittedCredential == null &&
            !existing.hasSameTarget(submission)
        ) {
            return@withContext PairingSaveResult.Failure(
                "Enter a new pairing code or access token when changing the target",
            )
        }

        if (submittedCredential == null && priorCredential == null) {
            return@withContext PairingSaveResult.Failure("Enter a pairing code or access token")
        }

        if (submittedCredential != null) {
            val newCredentialKey = runCatching(credentialKeyFactory).getOrNull()
            if (
                newCredentialKey.isNullOrBlank() ||
                newCredentialKey == priorCredentialKey ||
                mutableSnapshots.value?.nativeCredentialRefs.orEmpty().any {
                    it.logicalKey == newCredentialKey
                }
            ) {
                return@withContext PairingSaveResult.Failure("Could not stage the credential securely")
            }
            val verification = try {
                credentials.writeAndVerify(newCredentialKey, submittedCredential)
            } catch (_: Exception) {
                deleteStagedCredential(newCredentialKey)
                return@withContext PairingSaveResult.Failure("Could not save the credential securely")
            }
            when (verification) {
                CredentialWriteVerification.Verified -> Unit
                is CredentialWriteVerification.Failed -> {
                    deleteStagedCredential(newCredentialKey)
                    return@withContext PairingSaveResult.Failure("Could not save the credential securely")
                }
            }
            val row = submission.toEntity(connectionId)
            if (stored != null && editTicket != null) {
                when (commitEdit(editTicket, stored, row, newCredentialKey)) {
                    is EditCommit.Success -> Unit
                    EditCommit.Stale,
                    EditCommit.Conflict,
                    -> {
                        deleteStagedCredential(newCredentialKey)
                        return@withContext PairingSaveResult.Failure(
                            "This machine changed while saving. Review it and try again",
                        )
                    }
                    EditCommit.Failed -> {
                        deleteStagedCredential(newCredentialKey)
                        return@withContext PairingSaveResult.Failure("Could not save the machine")
                    }
                }
            } else {
                try {
                    database.upsert(row, newCredentialKey)
                } catch (_: Exception) {
                    deleteStagedCredential(newCredentialKey)
                    return@withContext PairingSaveResult.Failure("Could not save the machine")
                }
                publishSnapshot(row = row, activeCredentialKey = newCredentialKey)
            }
            if (priorCredentialKey != null && priorCredentialKey != newCredentialKey) {
                runCatching { credentials.deleteNativeOwned(priorCredentialKey) }
            }
            return@withContext PairingSaveResult.Success
        }

        val activeCredentialKey = requireNotNull(priorCredentialKey)
        val row = submission.toEntity(connectionId)
        when (commitEdit(requireNotNull(editTicket), requireNotNull(stored), row, activeCredentialKey)) {
            is EditCommit.Success -> PairingSaveResult.Success
            EditCommit.Stale,
            EditCommit.Conflict,
            -> PairingSaveResult.Failure(
                "This machine changed while saving. Review it and try again",
            )
            EditCommit.Failed -> PairingSaveResult.Failure("Could not save the machine")
        }
        }
    }

    private fun beginEdit(intent: PairingSaveIntent): EditTicket? =
        (intent as? PairingSaveIntent.Edit)?.let { edit ->
            synchronized(editCommitLock) {
                EditTicket(edit.connectionId, ++nextEditGeneration).also { ticket ->
                    latestEditGenerations[edit.connectionId] = ticket.generation
                }
            }
        }

    private fun commitEdit(
        ticket: EditTicket,
        expected: StoredConnection,
        replacement: ConnectionEntity,
        newCredentialRef: String,
    ): EditCommit = synchronized(editCommitLock) {
        if (latestEditGenerations[ticket.connectionId] != ticket.generation) {
            return@synchronized EditCommit.Stale
        }
        val snapshot = try {
            database.compareAndSwapConnection(expected, replacement, newCredentialRef)
                ?: return@synchronized EditCommit.Conflict
        } catch (_: Exception) {
            return@synchronized EditCommit.Failed
        }
        mutableSnapshots.value = snapshot
        EditCommit.Success(snapshot)
    }

    private fun deleteStagedCredential(logicalKey: String) {
        runCatching { credentials.deleteNativeOwned(logicalKey) }
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
        const val IAP_KIND = "iap"
    }
}

private fun PairingSubmission.selectedCredential(): SelectedCredential.Present? = when {
    pairing != null -> SelectedCredential.PairingToken(pairing)
    token != null -> SelectedCredential.LegacyInlineToken(token)
    else -> null
}

private fun PairingSubmission.normalizedForPersistence(): PairingSubmission? {
    return when (kind) {
        PairingConnectionKind.WEBSOCKET -> {
            val parsed = PairingUrl.parse(url) ?: return null
            if (parsed.endpoint != url || parsed.token != null || parsed.pairingCode != null) return null
            val normalizedPairing = pairing?.trim()?.ifEmpty { null }
            copy(
                label = label.trim().ifEmpty { parsed.endpoint.removeWebSocketScheme() },
                url = parsed.endpoint,
                token = if (normalizedPairing == null) token?.trim()?.ifEmpty { null } else null,
                pairing = normalizedPairing,
                project = null,
                zone = null,
                instance = null,
                port = null,
            )
        }
        PairingConnectionKind.IAP -> {
            val normalizedProject = project?.trim()?.ifEmpty { null } ?: return null
            val normalizedZone = zone?.trim()?.ifEmpty { null } ?: return null
            val normalizedInstance = instance?.trim()?.ifEmpty { null } ?: return null
            val normalizedPort = port?.takeIf { it in 1..65_535 } ?: return null
            if (url.isNotEmpty() || pairing != null) return null
            copy(
                label = label.trim().ifEmpty { normalizedInstance },
                url = "",
                token = token?.trim()?.ifEmpty { null },
                pairing = null,
                project = normalizedProject,
                zone = normalizedZone,
                instance = normalizedInstance,
                port = normalizedPort,
            )
        }
    }
}

private fun normalizedEndpoint(value: String?): String? =
    value?.let { PairingUrl.parse(it)?.endpoint ?: it }

private val PairingConnectionKind.storageValue: String
    get() = when (this) {
        PairingConnectionKind.WEBSOCKET -> "ws"
        PairingConnectionKind.IAP -> "iap"
    }

private fun String.removeWebSocketScheme(): String =
    removePrefix("ws://").removePrefix("wss://")

private fun ConnectionEntity.hasSameTarget(submission: PairingSubmission): Boolean = when (kind) {
    "ws" -> normalizedEndpoint(url) == normalizedEndpoint(submission.url)
    "iap" ->
        project == submission.project &&
            zone == submission.zone &&
            instance == submission.instance &&
            port == submission.port
    else -> false
}

private fun PairingSubmission.toEntity(
    connectionId: String,
) = ConnectionEntity(
    id = connectionId,
    label = label,
    kind = kind.storageValue,
    url = url.takeIf { kind == PairingConnectionKind.WEBSOCKET },
    project = project.takeIf { kind == PairingConnectionKind.IAP },
    zone = zone.takeIf { kind == PairingConnectionKind.IAP },
    instance = instance.takeIf { kind == PairingConnectionKind.IAP },
    port = port.takeIf { kind == PairingConnectionKind.IAP },
)
