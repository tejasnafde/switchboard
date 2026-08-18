package app.switchboard.mobile.data.connection

import app.switchboard.mobile.data.local.AppPreferenceEntity
import app.switchboard.mobile.data.local.ConnectionEntity
import app.switchboard.mobile.data.local.NativeCredentialRefEntity
import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.platform.migration.CredentialWriteVerification
import app.switchboard.mobile.platform.migration.SelectedCredential
import app.switchboard.mobile.platform.storage.NativeCredential
import app.switchboard.mobile.ui.pairing.PairingSaveIntent
import app.switchboard.mobile.ui.pairing.PairingSaveResult
import app.switchboard.mobile.ui.pairing.PairingSubmission
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeConnectionRepositoryTest {
    @Test
    fun saveBeforeStartupSnapshotFailsWithoutTouchingStorage() = runBlocking {
        val events = mutableListOf<String>()
        val repository = NativeConnectionRepository(
            database = FakeDatabase(events),
            credentials = FakeCredentials(events),
            dispatcher = Dispatchers.Unconfined,
        )

        val result = repository.save(
            PairingSaveIntent.Add(
                PairingSubmission("Studio", "ws://studio:8765", token = "secret"),
            ),
        )

        assertTrue(result is PairingSaveResult.Failure)
        assertTrue(events.isEmpty())
    }

    @Test
    fun addVerifiesCredentialBeforeUpsertAndPublishesDurableSnapshot() = runBlocking {
        val events = mutableListOf<String>()
        val database = FakeDatabase(events)
        val credentials = FakeCredentials(events)
        val repository = repository(database, credentials, id = "native-1")
        repository.seed(snapshot())

        val result = repository.save(
            PairingSaveIntent.Add(
                PairingSubmission(
                    label = "Studio",
                    url = "wss://studio.example/ws",
                    token = "top-secret",
                ),
            ),
        )

        assertEquals(PairingSaveResult.Success, result)
        assertEquals(listOf("credential:write", "database:upsert", "database:snapshot"), events)
        assertEquals("native-1", database.rows.single().id)
        assertEquals("credential-new", database.activeCredentialKeys.getValue("native-1"))
        assertEquals(setOf("credential-new"), credentials.stored.keys)
        assertFalse(database.rows.single().toString().contains("top-secret"))
        assertEquals(listOf("native-1"), repository.snapshots.value?.connections?.map { it.id })
    }

    @Test
    fun failedCredentialReadbackNeverWritesRoomAndKeepsSaveFailed() = runBlocking {
        val events = mutableListOf<String>()
        val database = FakeDatabase(events)
        val credentials = FakeCredentials(
            events,
            verification = CredentialWriteVerification.Failed("read-back mismatch"),
        )
        val repository = repository(database, credentials)

        val result = repository.save(
            PairingSaveIntent.Add(
                PairingSubmission("Studio", "ws://studio:8765", pairing = "pairing-secret"),
            ),
        )

        assertTrue(result is PairingSaveResult.Failure)
        assertEquals(listOf("credential:write", "credential:delete"), events)
        assertTrue(database.rows.isEmpty())
        assertFalse((result as PairingSaveResult.Failure).message.contains("pairing-secret"))
    }

    @Test
    fun editWithoutNewCredentialPreservesExistingNativeCredential() = runBlocking {
        val events = mutableListOf<String>()
        val original = connection(id = "machine-1", label = "Old", url = "ws://old:8765")
        val database = FakeDatabase(events, mutableListOf(original))
        val credentials = FakeCredentials(
            events,
            stored = mutableMapOf(
                "machine-1" to NativeCredential(
                    NativeCredential.Kind.DEVICE_SESSION,
                    "existing-session",
                ),
            ),
        )
        val repository = repository(database, credentials)

        val result = repository.save(
            PairingSaveIntent.Edit(
                connectionId = "machine-1",
                submission = PairingSubmission("Renamed", "ws://old:8765"),
                resetSession = true,
                reconnect = true,
            ),
        )

        assertEquals(PairingSaveResult.Success, result)
        assertEquals(
            listOf("database:find", "credential:read", "database:upsert", "database:snapshot"),
            events,
        )
        assertEquals("existing-session", credentials.stored.getValue("machine-1").value)
        assertEquals("Renamed", database.rows.single().label)
    }

    @Test
    fun editRejectsChangedEndpointWithoutAReplacementCredential() = runBlocking {
        val events = mutableListOf<String>()
        val original = connection(id = "machine-1", url = "ws://old:8765")
        val database = FakeDatabase(events, mutableListOf(original))
        val credentials = FakeCredentials(
            events,
            stored = mutableMapOf(
                "machine-1" to NativeCredential(
                    NativeCredential.Kind.DEVICE_SESSION,
                    "existing-session",
                ),
            ),
        )
        val repository = repository(database, credentials)

        val result = repository.save(
            PairingSaveIntent.Edit(
                connectionId = "machine-1",
                submission = PairingSubmission("Moved", "wss://different.example/ws"),
                resetSession = true,
                reconnect = true,
            ),
        )

        assertTrue(result is PairingSaveResult.Failure)
        assertEquals(listOf("database:find", "credential:read"), events)
        assertEquals(original, database.rows.single())
        assertEquals("existing-session", credentials.stored.getValue("machine-1").value)
    }

    @Test
    fun freshCredentialCommitsNewPointerBeforeRetiringOldNativeKey() = runBlocking {
        val events = mutableListOf<String>()
        val database = FakeDatabase(events, mutableListOf(connection("machine-1")))
        val credentials = FakeCredentials(
            events,
            stored = mutableMapOf(
                "machine-1" to NativeCredential(NativeCredential.Kind.DEVICE_SESSION, "old-session"),
            ),
        )
        val repository = repository(database, credentials)

        val result = repository.save(
            PairingSaveIntent.Edit(
                connectionId = "machine-1",
                submission = PairingSubmission("Moved", "ws://new:8765", pairing = "fresh-pair"),
                resetSession = true,
                reconnect = true,
            ),
        )

        assertEquals(PairingSaveResult.Success, result)
        assertEquals(
            listOf(
                "database:find",
                "credential:read",
                "credential:write",
                "database:upsert",
                "credential:delete",
                "database:snapshot",
            ),
            events,
        )
        assertEquals("credential-new", database.activeCredentialKeys.getValue("machine-1"))
        assertEquals(setOf("credential-new"), credentials.stored.keys)
    }

    @Test
    fun credentialReplacementPublishesAnUnequalSnapshotWithTheNewActiveReference() = runBlocking {
        val events = mutableListOf<String>()
        val database = FakeDatabase(events, mutableListOf(connection("machine-1")))
        val credentials = FakeCredentials(
            events,
            stored = mutableMapOf(
                "machine-1" to NativeCredential(NativeCredential.Kind.DEVICE_SESSION, "old-session"),
            ),
        )
        val repository = repository(database, credentials)
        val before = requireNotNull(repository.snapshots.value)

        val result = repository.save(
            PairingSaveIntent.Edit(
                connectionId = "machine-1",
                submission = PairingSubmission("machine-1", "ws://machine-1:8765", token = "replacement"),
                resetSession = true,
                reconnect = true,
            ),
        )

        assertEquals(PairingSaveResult.Success, result)
        val after = requireNotNull(repository.snapshots.value)
        assertFalse(before == after)
        assertEquals("machine-1", before.nativeCredentialRefs.single().logicalKey)
        assertEquals("credential-new", after.nativeCredentialRefs.single().logicalKey)
    }

    @Test
    fun failedRoomUpsertLeavesPriorPointerAndSecretIntactAndRetiresOnlyTheUncommittedKey() = runBlocking {
        val events = mutableListOf<String>()
        val original = connection("native-2", url = "ws://old:8765")
        val database = FakeDatabase(events, mutableListOf(original), failUpsert = true)
        val credentials = FakeCredentials(
            events,
            stored = mutableMapOf(
                "native-2" to NativeCredential(NativeCredential.Kind.DEVICE_SESSION, "prior-session"),
            ),
        )
        val repository = repository(database, credentials, id = "native-2")

        val result = repository.save(
            PairingSaveIntent.Edit(
                connectionId = "native-2",
                submission = PairingSubmission("Studio", "ws://new:8765", token = "secret"),
                resetSession = true,
                reconnect = true,
            ),
        )

        assertTrue(result is PairingSaveResult.Failure)
        assertEquals(
            listOf("database:find", "credential:read", "credential:write", "database:upsert", "credential:delete"),
            events,
        )
        assertEquals("native-2", database.activeCredentialKeys.getValue("native-2"))
        assertEquals("prior-session", credentials.stored.getValue("native-2").value)
        assertFalse(credentials.stored.containsKey("credential-new"))
    }

    @Test
    fun removalDeletesRoomFirstThenOnlyTheRowsNativeCredentialAndPublishes() = runBlocking {
        val events = mutableListOf<String>()
        val database = FakeDatabase(
            events,
            mutableListOf(
                connection("machine-1"),
                connection("machine-2"),
            ),
        )
        val credentials = FakeCredentials(
            events,
            stored = mutableMapOf(
                "machine-1" to NativeCredential(NativeCredential.Kind.DEVICE_SESSION, "one"),
                "machine-2" to NativeCredential(NativeCredential.Kind.DEVICE_SESSION, "two"),
            ),
        )
        val repository = repository(database, credentials)

        val result = repository.remove("machine-1")

        assertEquals(ConnectionRemoveResult.Success, result)
        assertEquals(
            listOf("database:find", "database:delete", "credential:delete", "database:snapshot"),
            events,
        )
        assertEquals(listOf("machine-2"), database.rows.map { it.id })
        assertEquals(setOf("machine-2"), credentials.stored.keys)
        assertEquals(listOf("machine-2"), repository.snapshots.value?.connections?.map { it.id })
    }

    private fun repository(
        database: FakeDatabase,
        credentials: FakeCredentials,
        id: String = "generated",
    ) = NativeConnectionRepository(
        database = database,
        credentials = credentials,
        idFactory = { id },
        credentialKeyFactory = { "credential-new" },
        dispatcher = Dispatchers.Unconfined,
    ).also {
        it.seed(
            snapshot(
                database.rows.toList(),
                database.activeCredentialKeys.map { (connectionId, logicalKey) ->
                    NativeCredentialRefEntity(connectionId, logicalKey)
                },
            ),
        )
    }

    private class FakeDatabase(
        private val events: MutableList<String>,
        val rows: MutableList<ConnectionEntity> = mutableListOf(),
        private val failUpsert: Boolean = false,
    ) : ConnectionDatabase {
        val activeCredentialKeys = rows.associate { it.id to it.id }.toMutableMap()

        override fun find(connectionId: String): StoredConnection? {
            events += "database:find"
            val row = rows.firstOrNull { it.id == connectionId } ?: return null
            return StoredConnection(row, activeCredentialKeys[connectionId])
        }

        override fun upsert(connection: ConnectionEntity, activeCredentialKey: String) {
            events += "database:upsert"
            if (failUpsert) error("disk full")
            rows.removeAll { it.id == connection.id }
            rows += connection
            activeCredentialKeys[connection.id] = activeCredentialKey
        }

        override fun delete(connectionId: String): Boolean {
            events += "database:delete"
            activeCredentialKeys.remove(connectionId)
            return rows.removeAll { it.id == connectionId }
        }

        override fun snapshot(): OfflineSnapshot {
            events += "database:snapshot"
            return snapshot(
                rows.toList(),
                activeCredentialKeys.map { (connectionId, logicalKey) ->
                    NativeCredentialRefEntity(connectionId, logicalKey)
                },
            )
        }
    }

    private class FakeCredentials(
        private val events: MutableList<String>,
        private val verification: CredentialWriteVerification = CredentialWriteVerification.Verified,
        val stored: MutableMap<String, NativeCredential> = mutableMapOf(),
    ) : ConnectionCredentialStore {
        override fun writeAndVerify(
            connectionId: String,
            credential: SelectedCredential.Present,
        ): CredentialWriteVerification {
            events += "credential:write"
            if (verification == CredentialWriteVerification.Verified) {
                stored[connectionId] = credential.toNativeCredential()
            }
            return verification
        }

        override fun read(logicalKey: String): NativeCredential? {
            events += "credential:read"
            return stored[logicalKey]
        }

        override fun deleteNativeOwned(logicalKey: String): Boolean {
            events += "credential:delete"
            stored.remove(logicalKey)
            return true
        }
    }
}

private fun connection(
    id: String,
    label: String = id,
    url: String = "ws://$id:8765",
) = ConnectionEntity(
    id = id,
    label = label,
    kind = "ws",
    url = url,
    project = null,
    zone = null,
    instance = null,
    port = null,
)

private fun snapshot(
    connections: List<ConnectionEntity> = emptyList(),
    nativeCredentialRefs: List<NativeCredentialRefEntity> = emptyList(),
) = OfflineSnapshot(
    connections = connections,
    credentialRefs = emptyList(),
    nativeCredentialRefs = nativeCredentialRefs,
    preferences = listOf(AppPreferenceEntity("test", "preserved")),
    threadPreferences = emptyList(),
    collapsedWorkspaces = emptyList(),
    cachedThreads = emptyList(),
    feedRows = emptyList(),
    outbox = emptyList(),
    outboxAttachments = emptyList(),
    replayStates = emptyList(),
    pendingControlActions = emptyList(),
    quarantinedRecords = emptyList(),
)

private fun SelectedCredential.Present.toNativeCredential(): NativeCredential = when (this) {
    is SelectedCredential.DeviceSession -> NativeCredential(NativeCredential.Kind.DEVICE_SESSION, value)
    is SelectedCredential.PairingToken -> NativeCredential(NativeCredential.Kind.PAIRING_TOKEN, value)
    is SelectedCredential.LegacyInlineToken -> NativeCredential(NativeCredential.Kind.LEGACY_INLINE_TOKEN, value)
}
