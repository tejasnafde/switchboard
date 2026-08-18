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
import app.switchboard.mobile.ui.pairing.PairingConnectionKind
import app.switchboard.mobile.ui.pairing.PairingSubmission
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
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
    fun addIapStagesLegacyTokenBeforeAtomicallyPublishingExactTarget() = runBlocking {
        val events = mutableListOf<String>()
        val database = FakeDatabase(events)
        val credentials = FakeCredentials(events)
        val repository = repository(database, credentials, id = "iap-1")

        val result = repository.save(
            PairingSaveIntent.Add(
                PairingSubmission(
                    label = "Work VM",
                    kind = PairingConnectionKind.IAP,
                    project = "project",
                    zone = "asia-south1-b",
                    instance = "work-vm",
                    port = 8766,
                    token = "backend-secret",
                ),
            ),
        )

        assertEquals(PairingSaveResult.Success, result)
        assertEquals(listOf("credential:write", "database:upsert", "database:snapshot"), events)
        assertEquals(
            ConnectionEntity(
                id = "iap-1",
                label = "Work VM",
                kind = "iap",
                url = null,
                project = "project",
                zone = "asia-south1-b",
                instance = "work-vm",
                port = 8766,
            ),
            database.rows.single(),
        )
        assertEquals(
            NativeCredential(NativeCredential.Kind.LEGACY_INLINE_TOKEN, "backend-secret"),
            credentials.stored.getValue("credential-new"),
        )
        assertFalse(database.rows.single().toString().contains("backend-secret"))
    }

    @Test
    fun malformedIapSubmissionCannotTouchRoomOrEncryptedStorage() = runBlocking {
        val events = mutableListOf<String>()
        val database = FakeDatabase(events)
        val credentials = FakeCredentials(events)
        val repository = repository(database, credentials, id = "iap-1")

        val result = repository.save(
            PairingSaveIntent.Add(
                iapSubmission(project = "", token = "backend-secret"),
            ),
        )

        assertTrue(result is PairingSaveResult.Failure)
        assertTrue(events.isEmpty())
        assertTrue(database.rows.isEmpty())
        assertTrue(credentials.stored.isEmpty())
    }

    @Test
    fun iapEditFormPrefillsTopologyButNeverDecryptsSecretIntoUiState() {
        val events = mutableListOf<String>()
        val row = iapConnection("iap-1")
        val database = FakeDatabase(events, mutableListOf(row))
        val credentials = FakeCredentials(
            events,
            stored = mutableMapOf(
                "iap-1" to NativeCredential(NativeCredential.Kind.LEGACY_INLINE_TOKEN, "backend-secret"),
            ),
        )
        val repository = repository(database, credentials)

        assertEquals(
            app.switchboard.mobile.ui.pairing.PairingForm(
                kind = PairingConnectionKind.IAP,
                label = "Work VM",
                project = "project",
                zone = "asia-south1-b",
                instance = "work-vm",
                port = "8766",
                token = "",
            ),
            repository.editForm("iap-1"),
        )
        assertTrue(events.isEmpty())
    }

    @Test
    fun unchangedIapTopologyWithBlankTokenPreservesExactEncryptedCredential() = runBlocking {
        val events = mutableListOf<String>()
        val original = iapConnection("iap-1")
        val database = FakeDatabase(events, mutableListOf(original))
        val credential = NativeCredential(NativeCredential.Kind.LEGACY_INLINE_TOKEN, "backend-secret")
        val credentials = FakeCredentials(events, stored = mutableMapOf("iap-1" to credential))
        val repository = repository(database, credentials)

        val result = repository.save(
            PairingSaveIntent.Edit(
                connectionId = "iap-1",
                submission = iapSubmission(label = "Renamed"),
                resetSession = true,
                reconnect = true,
            ),
        )

        assertEquals(PairingSaveResult.Success, result)
        assertEquals(credential, credentials.stored.getValue("iap-1"))
        assertEquals("Renamed", database.rows.single().label)
        assertEquals(listOf("database:find", "credential:read", "database:cas", "database:snapshot"), events)
    }

    @Test
    fun changedIapTopologyRequiresReplacementTokenAndLeavesRoomAndSecretUntouched() = runBlocking {
        val events = mutableListOf<String>()
        val original = iapConnection("iap-1")
        val database = FakeDatabase(events, mutableListOf(original))
        val credential = NativeCredential(NativeCredential.Kind.LEGACY_INLINE_TOKEN, "backend-secret")
        val credentials = FakeCredentials(events, stored = mutableMapOf("iap-1" to credential))
        val repository = repository(database, credentials)

        val result = repository.save(
            PairingSaveIntent.Edit(
                connectionId = "iap-1",
                submission = iapSubmission(port = 9000),
                resetSession = true,
                reconnect = true,
            ),
        )

        assertTrue(result is PairingSaveResult.Failure)
        assertEquals(original, database.rows.single())
        assertEquals(credential, credentials.stored.getValue("iap-1"))
        assertEquals(listOf("database:find", "credential:read"), events)
    }

    @Test
    fun editCannotChangeConnectionTransportKindEvenWithAReplacementToken() = runBlocking {
        val events = mutableListOf<String>()
        val original = connection("machine-1")
        val database = FakeDatabase(events, mutableListOf(original))
        val credentials = FakeCredentials(
            events,
            stored = mutableMapOf(
                "machine-1" to NativeCredential(NativeCredential.Kind.DEVICE_SESSION, "session"),
            ),
        )
        val repository = repository(database, credentials)

        val result = repository.save(
            PairingSaveIntent.Edit(
                connectionId = "machine-1",
                submission = iapSubmission(token = "replacement"),
                resetSession = true,
                reconnect = true,
            ),
        )

        assertTrue(result is PairingSaveResult.Failure)
        assertEquals(original, database.rows.single())
        assertEquals(setOf("machine-1"), credentials.stored.keys)
        assertEquals(listOf("database:find", "credential:read"), events)
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
            listOf("database:find", "credential:read", "database:cas", "database:snapshot"),
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
                "database:cas",
                "database:snapshot",
                "credential:delete",
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
            listOf("database:find", "credential:read", "credential:write", "database:cas", "credential:delete"),
            events,
        )
        assertEquals("native-2", database.activeCredentialKeys.getValue("native-2"))
        assertEquals("prior-session", credentials.stored.getValue("native-2").value)
        assertFalse(credentials.stored.containsKey("credential-new"))
    }

    @Test
    fun replacementRejectsAStagingKeyThatWouldOverwriteTheActiveCredential() = runBlocking {
        val events = mutableListOf<String>()
        val original = connection("machine-1")
        val database = FakeDatabase(events, mutableListOf(original))
        val credentials = FakeCredentials(
            events,
            stored = mutableMapOf(
                "machine-1" to NativeCredential(NativeCredential.Kind.DEVICE_SESSION, "old-session"),
            ),
        )
        val repository = NativeConnectionRepository(
            database = database,
            credentials = credentials,
            credentialKeyFactory = { "machine-1" },
            dispatcher = Dispatchers.Unconfined,
        ).also { it.seed(snapshot(listOf(original), listOf(NativeCredentialRefEntity("machine-1", "machine-1")))) }

        val result = repository.save(
            PairingSaveIntent.Edit(
                "machine-1",
                PairingSubmission("Changed", "ws://machine-1:8765", token = "replacement"),
                resetSession = true,
                reconnect = true,
            ),
        )

        assertTrue(result is PairingSaveResult.Failure)
        assertEquals(original, database.rows.single())
        assertEquals("machine-1", database.activeCredentialKeys.getValue("machine-1"))
        assertEquals("old-session", credentials.stored.getValue("machine-1").value)
        assertEquals(listOf("database:find", "credential:read"), events)
    }

    @Test
    fun replacementRejectsAStagingKeyOwnedByAnotherStoredConnection() = runBlocking {
        val events = mutableListOf<String>()
        val first = connection("machine-1")
        val second = connection("machine-2")
        val database = FakeDatabase(events, mutableListOf(first, second))
        val credentials = FakeCredentials(
            events,
            stored = mutableMapOf(
                "machine-1" to NativeCredential(NativeCredential.Kind.DEVICE_SESSION, "session-one"),
                "machine-2" to NativeCredential(NativeCredential.Kind.DEVICE_SESSION, "session-two"),
            ),
        )
        val repository = NativeConnectionRepository(
            database = database,
            credentials = credentials,
            credentialKeyFactory = { "machine-2" },
            dispatcher = Dispatchers.Unconfined,
        ).also {
            it.seed(
                snapshot(
                    listOf(first, second),
                    listOf(
                        NativeCredentialRefEntity("machine-1", "machine-1"),
                        NativeCredentialRefEntity("machine-2", "machine-2"),
                    ),
                ),
            )
        }

        val result = repository.save(
            PairingSaveIntent.Edit(
                "machine-1",
                PairingSubmission("Changed", "ws://machine-1:8765", token = "replacement"),
                resetSession = true,
                reconnect = true,
            ),
        )

        assertTrue(result is PairingSaveResult.Failure)
        assertEquals("session-one", credentials.stored.getValue("machine-1").value)
        assertEquals("session-two", credentials.stored.getValue("machine-2").value)
        assertEquals("machine-1", database.activeCredentialKeys.getValue("machine-1"))
        assertEquals(listOf("database:find", "credential:read"), events)
    }

    @Test
    fun newerEditWinsWhenAnOlderCredentialWriteCompletesLast() = runBlocking {
        val events = mutableListOf<String>()
        val original = connection("machine-1", label = "Original")
        val firstWriteStarted = CountDownLatch(1)
        val releaseFirstWrite = CountDownLatch(1)
        val database = FakeDatabase(events, mutableListOf(original))
        val credentials = FakeCredentials(
            events,
            stored = mutableMapOf(
                "machine-1" to NativeCredential(NativeCredential.Kind.DEVICE_SESSION, "old-session"),
            ),
            beforeWrite = { logicalKey ->
                if (logicalKey == "credential-a") {
                    firstWriteStarted.countDown()
                    check(releaseFirstWrite.await(5, TimeUnit.SECONDS))
                }
            },
        )
        val keys = ArrayDeque(listOf("credential-a", "credential-b"))
        val repository = NativeConnectionRepository(
            database = database,
            credentials = credentials,
            credentialKeyFactory = { synchronized(keys) { keys.removeFirst() } },
            dispatcher = Dispatchers.Default,
        ).also { it.seed(snapshot(listOf(original), listOf(NativeCredentialRefEntity("machine-1", "machine-1")))) }

        val older = async(Dispatchers.Default) {
            repository.save(
                PairingSaveIntent.Edit(
                    "machine-1",
                    PairingSubmission("Older", "ws://machine-1:8765", token = "older-secret"),
                    resetSession = true,
                    reconnect = true,
                ),
            )
        }
        assertTrue(firstWriteStarted.await(5, TimeUnit.SECONDS))
        val newer = async(Dispatchers.Default) {
            repository.save(
                PairingSaveIntent.Edit(
                    "machine-1",
                    PairingSubmission("Newer", "ws://machine-1:8765", token = "newer-secret"),
                    resetSession = true,
                    reconnect = true,
                ),
            )
        }
        val newerResult = newer.await()
        releaseFirstWrite.countDown()
        val olderResult = older.await()

        assertEquals(PairingSaveResult.Success, newerResult)
        assertTrue(olderResult is PairingSaveResult.Failure)
        assertEquals("Newer", database.rows.single().label)
        assertEquals("credential-b", database.activeCredentialKeys.getValue("machine-1"))
        assertEquals(setOf("credential-b"), credentials.stored.keys)
    }

    @Test
    fun editCannotOverwriteAConnectionAndRefChangedOutsideItsReadSnapshot() = runBlocking {
        val events = mutableListOf<String>()
        val original = connection("machine-1", label = "Original")
        val external = connection("machine-1", label = "External")
        lateinit var database: FakeDatabase
        database = FakeDatabase(
            events,
            mutableListOf(original),
            beforeCommit = {
                database.rows.clear()
                database.rows += external
                database.activeCredentialKeys["machine-1"] = "external-key"
            },
        )
        val credentials = FakeCredentials(
            events,
            stored = mutableMapOf(
                "machine-1" to NativeCredential(NativeCredential.Kind.DEVICE_SESSION, "old-session"),
                "external-key" to NativeCredential(NativeCredential.Kind.DEVICE_SESSION, "external-session"),
            ),
        )
        val repository = repository(database, credentials)

        val result = repository.save(
            PairingSaveIntent.Edit(
                "machine-1",
                PairingSubmission("Submitted", "ws://machine-1:8765", token = "replacement"),
                resetSession = true,
                reconnect = true,
            ),
        )

        assertTrue(result is PairingSaveResult.Failure)
        assertEquals(external, database.rows.single())
        assertEquals("external-key", database.activeCredentialKeys.getValue("machine-1"))
        assertEquals(setOf("machine-1", "external-key"), credentials.stored.keys)
    }

    @Test
    fun cleanupFailureAfterDurableReplacementRemainsSuccessAndKeepsBothNativeKeys() = runBlocking {
        val events = mutableListOf<String>()
        val original = connection("machine-1")
        val database = FakeDatabase(events, mutableListOf(original))
        val credentials = FakeCredentials(
            events,
            stored = mutableMapOf(
                "machine-1" to NativeCredential(NativeCredential.Kind.DEVICE_SESSION, "old-session"),
            ),
            deleteSucceeds = false,
        )
        val repository = repository(database, credentials)

        val result = repository.save(
            PairingSaveIntent.Edit(
                "machine-1",
                PairingSubmission("Changed", "ws://machine-1:8765", token = "replacement"),
                resetSession = true,
                reconnect = true,
            ),
        )

        assertEquals(PairingSaveResult.Success, result)
        assertEquals("credential-new", database.activeCredentialKeys.getValue("machine-1"))
        assertEquals(setOf("machine-1", "credential-new"), credentials.stored.keys)
    }

    @Test
    fun credentialWriteExceptionReturnsDefiniteFailureAndCleansOnlyTheStagingKey() = runBlocking {
        val events = mutableListOf<String>()
        val original = connection("machine-1")
        val database = FakeDatabase(events, mutableListOf(original))
        val credentials = FakeCredentials(
            events,
            stored = mutableMapOf(
                "machine-1" to NativeCredential(NativeCredential.Kind.DEVICE_SESSION, "old-session"),
            ),
            writeFailure = IllegalStateException("keystore unavailable"),
        )
        val repository = repository(database, credentials)

        val result = repository.save(
            PairingSaveIntent.Edit(
                "machine-1",
                PairingSubmission("Changed", "ws://machine-1:8765", token = "replacement"),
                resetSession = true,
                reconnect = true,
            ),
        )

        assertTrue(result is PairingSaveResult.Failure)
        assertEquals(original, database.rows.single())
        assertEquals("machine-1", database.activeCredentialKeys.getValue("machine-1"))
        assertEquals(setOf("machine-1"), credentials.stored.keys)
        assertEquals(
            listOf("database:find", "credential:read", "credential:write", "credential:delete"),
            events,
        )
    }

    @Test
    fun roomReadExceptionReturnsDefiniteFailureWithoutTouchingCredentialStorage() = runBlocking {
        val events = mutableListOf<String>()
        val original = connection("machine-1")
        val database = FakeDatabase(events, mutableListOf(original), failFind = true)
        val credentials = FakeCredentials(
            events,
            stored = mutableMapOf(
                "machine-1" to NativeCredential(NativeCredential.Kind.DEVICE_SESSION, "old-session"),
            ),
        )
        val repository = repository(database, credentials)

        val call = runCatching {
            repository.save(
                PairingSaveIntent.Edit(
                    "machine-1",
                    PairingSubmission("Changed", "ws://machine-1:8765", token = "replacement"),
                    resetSession = true,
                    reconnect = true,
                ),
            )
        }

        assertTrue(call.isSuccess)
        assertTrue(call.getOrNull() is PairingSaveResult.Failure)
        assertEquals(original, database.rows.single())
        assertEquals(setOf("machine-1"), credentials.stored.keys)
        assertEquals(listOf("database:find"), events)
    }

    @Test
    fun credentialReadExceptionReturnsDefiniteFailureWithoutChangingRoomOrSecrets() = runBlocking {
        val events = mutableListOf<String>()
        val original = connection("machine-1")
        val database = FakeDatabase(events, mutableListOf(original))
        val credentials = FakeCredentials(
            events,
            stored = mutableMapOf(
                "machine-1" to NativeCredential(NativeCredential.Kind.DEVICE_SESSION, "old-session"),
            ),
            readFailure = IllegalStateException("keystore unavailable"),
        )
        val repository = repository(database, credentials)

        val call = runCatching {
            repository.save(
                PairingSaveIntent.Edit(
                    "machine-1",
                    PairingSubmission("Changed", "ws://machine-1:8765"),
                    resetSession = true,
                    reconnect = true,
                ),
            )
        }

        assertTrue(call.isSuccess)
        assertTrue(call.getOrNull() is PairingSaveResult.Failure)
        assertEquals(original, database.rows.single())
        assertEquals("machine-1", database.activeCredentialKeys.getValue("machine-1"))
        assertEquals(setOf("machine-1"), credentials.stored.keys)
        assertEquals(listOf("database:find", "credential:read"), events)
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
        private val beforeCommit: (() -> Unit)? = null,
        private val failFind: Boolean = false,
    ) : ConnectionDatabase {
        val activeCredentialKeys = rows.associate { it.id to it.id }.toMutableMap()

        override fun find(connectionId: String): StoredConnection? {
            events += "database:find"
            if (failFind) error("database unavailable")
            val row = rows.firstOrNull { it.id == connectionId } ?: return null
            return StoredConnection(row, activeCredentialKeys[connectionId])
        }

        override fun upsert(connection: ConnectionEntity, activeCredentialKey: String) {
            events += "database:upsert"
            beforeCommit?.invoke()
            if (failUpsert) error("disk full")
            rows.removeAll { it.id == connection.id }
            rows += connection
            activeCredentialKeys[connection.id] = activeCredentialKey
        }

        override fun compareAndSwapConnection(
            expected: StoredConnection,
            replacement: ConnectionEntity,
            newCredentialRef: String,
        ): OfflineSnapshot? {
            events += "database:cas"
            beforeCommit?.invoke()
            if (failUpsert) error("disk full")
            val current = rows.firstOrNull { it.id == expected.connection.id }
            if (
                current != expected.connection ||
                activeCredentialKeys[expected.connection.id] != expected.activeCredentialKey
            ) {
                return null
            }
            rows.removeAll { it.id == replacement.id }
            rows += replacement
            activeCredentialKeys[replacement.id] = newCredentialRef
            return snapshot()
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
        private val beforeWrite: (String) -> Unit = {},
        private val deleteSucceeds: Boolean = true,
        private val writeFailure: RuntimeException? = null,
        private val readFailure: RuntimeException? = null,
    ) : ConnectionCredentialStore {
        override fun writeAndVerify(
            logicalKey: String,
            credential: SelectedCredential.Present,
        ): CredentialWriteVerification {
            events += "credential:write"
            beforeWrite(logicalKey)
            writeFailure?.let { throw it }
            if (verification == CredentialWriteVerification.Verified) {
                stored[logicalKey] = credential.toNativeCredential()
            }
            return verification
        }

        override fun read(logicalKey: String): NativeCredential? {
            events += "credential:read"
            readFailure?.let { throw it }
            return stored[logicalKey]
        }

        override fun deleteNativeOwned(logicalKey: String): Boolean {
            events += "credential:delete"
            if (deleteSucceeds) stored.remove(logicalKey)
            return deleteSucceeds
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

private fun iapConnection(
    id: String,
    label: String = "Work VM",
    project: String = "project",
    zone: String = "asia-south1-b",
    instance: String = "work-vm",
    port: Int = 8766,
) = ConnectionEntity(
    id = id,
    label = label,
    kind = "iap",
    url = null,
    project = project,
    zone = zone,
    instance = instance,
    port = port,
)

private fun iapSubmission(
    label: String = "Work VM",
    project: String = "project",
    zone: String = "asia-south1-b",
    instance: String = "work-vm",
    port: Int = 8766,
    token: String? = null,
) = PairingSubmission(
    label = label,
    kind = PairingConnectionKind.IAP,
    project = project,
    zone = zone,
    instance = instance,
    port = port,
    token = token,
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
