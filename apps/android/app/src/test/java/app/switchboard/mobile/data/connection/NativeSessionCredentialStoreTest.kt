package app.switchboard.mobile.data.connection

import app.switchboard.mobile.data.local.ConnectionEntity
import app.switchboard.mobile.data.local.NativeCredentialRefEntity
import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.platform.migration.CredentialWriteVerification
import app.switchboard.mobile.platform.migration.SelectedCredential
import app.switchboard.mobile.platform.storage.NativeCredential
import kotlinx.coroutines.Dispatchers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeSessionCredentialStoreTest {
    @Test
    fun verifiedSessionCasPublishesNewRefBeforeOldNativeKeyRetires() {
        val fixture = Fixture()
        val before = requireNotNull(fixture.repository.snapshots.value)

        assertTrue(
            fixture.sessions.saveAndVerifySession("machine", "pair-ref", "minted-session"),
        )

        val after = requireNotNull(fixture.repository.snapshots.value)
        assertFalse(before == after)
        assertEquals("session-ref", after.nativeCredentialRefs.single().logicalKey)
        assertEquals(
            listOf(
                "database:find",
                "credential:read:pair-ref",
                "credential:write:session-ref",
                "database:cas:pair-ref:session-ref",
            ),
            fixture.events,
        )
        assertTrue(fixture.credentials.values.containsKey("pair-ref"))
        assertEquals(
            NativeCredential(NativeCredential.Kind.DEVICE_SESSION, "minted-session"),
            fixture.credentials.values["session-ref"],
        )

        fixture.sessions.retireLegacyCredentials("machine")

        assertFalse(fixture.credentials.values.containsKey("pair-ref"))
        assertEquals("credential:delete:pair-ref", fixture.events.last())
    }

    @Test
    fun failedReadbackLeavesDatabaseAndOldCredentialUntouched() {
        val fixture = Fixture()
        fixture.credentials.verification = CredentialWriteVerification.Failed("secret mismatch")

        assertFalse(
            fixture.sessions.saveAndVerifySession("machine", "pair-ref", "minted-secret"),
        )

        assertEquals("pair-ref", fixture.database.activeRef)
        assertTrue(fixture.credentials.values.containsKey("pair-ref"))
        assertFalse(fixture.credentials.values.containsKey("session-ref"))
        assertFalse(fixture.events.any { it.startsWith("database:cas") })
        assertFalse(fixture.sessions.toString().contains("minted-secret"))
    }

    @Test
    fun databaseFailureDeletesOnlyTheUnreferencedNewSessionKey() {
        val fixture = Fixture()
        fixture.database.casFailure = IllegalStateException("database unavailable")

        assertFalse(
            fixture.sessions.saveAndVerifySession("machine", "pair-ref", "minted-session"),
        )

        assertEquals("pair-ref", fixture.database.activeRef)
        assertEquals(setOf("pair-ref"), fixture.credentials.values.keys)
        assertEquals("credential:delete:session-ref", fixture.events.last())
    }

    @Test
    fun staleHandshakeCannotOverwriteAConcurrentReplacement() {
        val fixture = Fixture()
        fixture.database.beforeCas = {
            fixture.database.activeRef = "newer-pair-ref"
            fixture.credentials.values["newer-pair-ref"] =
                NativeCredential(NativeCredential.Kind.PAIRING_TOKEN, "newer-pair")
        }

        assertFalse(
            fixture.sessions.saveAndVerifySession("machine", "pair-ref", "stale-session"),
        )

        assertEquals("newer-pair-ref", fixture.database.activeRef)
        assertTrue(fixture.credentials.values.containsKey("newer-pair-ref"))
        assertFalse(fixture.credentials.values.containsKey("session-ref"))
    }

    @Test
    fun staleHandshakeCannotResurrectAConcurrentRemoval() {
        val fixture = Fixture()
        fixture.database.beforeCas = {
            fixture.database.row = null
            fixture.database.activeRef = null
        }

        assertFalse(
            fixture.sessions.saveAndVerifySession("machine", "pair-ref", "stale-session"),
        )

        assertEquals(null, fixture.database.row)
        assertEquals(null, fixture.database.activeRef)
        assertFalse(fixture.credentials.values.containsKey("session-ref"))
    }

    @Test
    fun cleanupFailureIsGenericRetryableAndIdempotent() {
        val fixture = Fixture()
        assertTrue(
            fixture.sessions.saveAndVerifySession("machine", "pair-ref", "minted-session"),
        )
        fixture.credentials.failDeletes += "pair-ref"

        fixture.sessions.retireLegacyCredentials("machine")
        assertEquals(listOf("machine"), fixture.cleanupDeferred)
        assertTrue(fixture.credentials.values.containsKey("pair-ref"))
        assertEquals("session-ref", fixture.database.activeRef)

        fixture.credentials.failDeletes.clear()
        fixture.sessions.retireLegacyCredentials("machine")
        val eventCount = fixture.events.size
        fixture.sessions.retireLegacyCredentials("machine")

        assertFalse(fixture.credentials.values.containsKey("pair-ref"))
        assertEquals(eventCount, fixture.events.size)
    }

    @Test
    fun blankOrNonPairingExpectedRefFailsClosedWithoutWriting() {
        val fixture = Fixture()
        assertFalse(fixture.sessions.saveAndVerifySession("machine", "", "session"))
        fixture.credentials.values["pair-ref"] =
            NativeCredential(NativeCredential.Kind.DEVICE_SESSION, "already-rotated")
        assertFalse(fixture.sessions.saveAndVerifySession("machine", "pair-ref", "session"))

        assertFalse(fixture.events.any { it.startsWith("credential:write") })
        assertEquals("pair-ref", fixture.database.activeRef)
    }

    private class Fixture {
        val events = mutableListOf<String>()
        val database = FakeDatabase(events)
        val credentials = FakeCredentials(events)
        val cleanupDeferred = mutableListOf<String>()
        val repository = NativeConnectionRepository(
            database = database,
            credentials = credentials,
            dispatcher = Dispatchers.Unconfined,
        ).also { it.seed(database.currentSnapshot()) }
        val sessions = NativeSessionCredentialStore(
            repository = repository,
            credentials = credentials,
            credentialKeyFactory = { "session-ref" },
            observer = NativeSessionCredentialObserver { connectionId ->
                cleanupDeferred.add(connectionId)
                Unit
            },
        )
    }

    private class FakeDatabase(
        private val events: MutableList<String>,
    ) : ConnectionDatabase {
        var row: ConnectionEntity? = connection()
        var activeRef: String? = "pair-ref"
        var beforeCas: (() -> Unit)? = null
        var casFailure: RuntimeException? = null

        override fun find(connectionId: String): StoredConnection? {
            events += "database:find"
            return row?.takeIf { it.id == connectionId }?.let { StoredConnection(it, activeRef) }
        }

        override fun upsert(connection: ConnectionEntity, activeCredentialKey: String) = error("unused")

        override fun compareAndSwapCredentialRef(
            connectionId: String,
            expectedOldRef: String,
            newRef: String,
        ): OfflineSnapshot? {
            events += "database:cas:$expectedOldRef:$newRef"
            casFailure?.let { throw it }
            beforeCas?.invoke()
            if (row?.id != connectionId || activeRef != expectedOldRef) return null
            activeRef = newRef
            return currentSnapshot()
        }

        override fun delete(connectionId: String): Boolean = error("unused")

        override fun snapshot(): OfflineSnapshot = currentSnapshot()

        fun currentSnapshot() = emptySnapshot(
            connections = listOfNotNull(row),
            nativeCredentialRefs = if (row != null && activeRef != null) {
                listOf(NativeCredentialRefEntity("machine", requireNotNull(activeRef)))
            } else {
                emptyList()
            },
        )
    }

    private class FakeCredentials(
        private val events: MutableList<String>,
    ) : ConnectionCredentialStore {
        val values = mutableMapOf(
            "pair-ref" to NativeCredential(NativeCredential.Kind.PAIRING_TOKEN, "pair-secret"),
        )
        val failDeletes = mutableSetOf<String>()
        var verification: CredentialWriteVerification = CredentialWriteVerification.Verified

        override fun writeAndVerify(
            logicalKey: String,
            credential: SelectedCredential.Present,
        ): CredentialWriteVerification {
            events += "credential:write:$logicalKey"
            if (verification == CredentialWriteVerification.Verified) {
                values[logicalKey] = when (credential) {
                    is SelectedCredential.DeviceSession ->
                        NativeCredential(NativeCredential.Kind.DEVICE_SESSION, credential.value)
                    is SelectedCredential.PairingToken ->
                        NativeCredential(NativeCredential.Kind.PAIRING_TOKEN, credential.value)
                    is SelectedCredential.LegacyInlineToken ->
                        NativeCredential(NativeCredential.Kind.LEGACY_INLINE_TOKEN, credential.value)
                }
            }
            return verification
        }

        override fun read(logicalKey: String): NativeCredential? {
            events += "credential:read:$logicalKey"
            return values[logicalKey]
        }

        override fun deleteNativeOwned(logicalKey: String): Boolean {
            events += "credential:delete:$logicalKey"
            if (logicalKey in failDeletes) return false
            values.remove(logicalKey)
            return true
        }
    }

    private companion object {
        fun connection() = ConnectionEntity(
            id = "machine",
            label = "Machine",
            kind = "ws",
            url = "wss://machine/ws",
            project = null,
            zone = null,
            instance = null,
            port = null,
        )

        fun emptySnapshot(
            connections: List<ConnectionEntity>,
            nativeCredentialRefs: List<NativeCredentialRefEntity>,
        ) = OfflineSnapshot(
            connections = connections,
            credentialRefs = emptyList(),
            nativeCredentialRefs = nativeCredentialRefs,
            preferences = emptyList(),
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
    }
}
