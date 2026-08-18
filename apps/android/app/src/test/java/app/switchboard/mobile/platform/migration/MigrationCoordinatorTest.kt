package app.switchboard.mobile.platform.migration

import app.switchboard.mobile.compat.LegacySecureStoreKeys
import app.switchboard.mobile.compat.LegacyStateDecoder
import app.switchboard.mobile.data.MigrationCheckpoint
import app.switchboard.mobile.data.MigrationDecision
import app.switchboard.mobile.data.MigrationPlanner
import app.switchboard.mobile.data.NativeMigrationStore
import app.switchboard.mobile.data.NativeMigrationTransaction
import app.switchboard.mobile.data.NativeMigrationWrite
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MigrationCoordinatorTest {
    @Test
    fun inventoriesDecryptsVerifiesExecutesAndOnlyThenReleasesDialing() {
        val events = mutableListOf<String>()
        val rows = connectionRows(inlineToken = "inline")
        val plan = (MigrationPlanner.plan(LegacyStateDecoder.decode(rows)) as MigrationDecision.Ready).plan
        val store = RecordingStore(plan.nativeFingerprint, events)
        val secrets = RecordingSecrets(
            mapOf(
                LegacySecureStoreKeys.sessionKey(CONNECTION_ID) to LegacySecureValue.Found("session"),
                LegacySecureStoreKeys.tokenKey(CONNECTION_ID) to LegacySecureValue.Found("pairing"),
            ),
            events,
        )
        val credentials = RecordingCredentialStore(CredentialWriteVerification.Verified, events)
        val dialGate = RecordingDialGate(events)

        val result = MigrationCoordinator(
            inventory = inventory(rows, events),
            secrets = secrets,
            credentials = credentials,
            store = store,
            dialGate = dialGate,
        ).run()

        assertTrue(result is StartupMigrationState.Ready)
        result as StartupMigrationState.Ready
        assertTrue(result.offlineSafe)
        assertEquals(SelectedCredential.DeviceSession("session"), credentials.writes.single().second)
        assertEquals(
            listOf(LegacyCredentialRetirement(CONNECTION_ID, LegacySecureStoreKeys.sessionKey(CONNECTION_ID))),
            result.retirementCandidates,
        )
        assertOrdered(events, "inventory", "secret:${LegacySecureStoreKeys.sessionKey(CONNECTION_ID)}", "credential:$CONNECTION_ID", "transaction:start", "dial:release")
    }

    @Test
    fun unreadableHigherPrioritySecretBlocksWithoutFallingBackWritingOrDialing() {
        val events = mutableListOf<String>()
        val rows = connectionRows(inlineToken = "inline")
        val plan = (MigrationPlanner.plan(LegacyStateDecoder.decode(rows)) as MigrationDecision.Ready).plan
        val credentials = RecordingCredentialStore(CredentialWriteVerification.Verified, events)
        val store = RecordingStore(plan.nativeFingerprint, events)
        val result = MigrationCoordinator(
            inventory = inventory(rows, events),
            secrets = RecordingSecrets(
                mapOf(
                    LegacySecureStoreKeys.sessionKey(CONNECTION_ID) to LegacySecureValue.Failure(
                        LegacySecureValue.Failure.Kind.KEY_UNAVAILABLE,
                        "locked",
                    ),
                    LegacySecureStoreKeys.tokenKey(CONNECTION_ID) to LegacySecureValue.Found("pairing"),
                ),
                events,
            ),
            credentials = credentials,
            store = store,
            dialGate = RecordingDialGate(events),
        ).run()

        assertTrue(result is StartupMigrationState.Blocked)
        assertTrue((result as StartupMigrationState.Blocked).reasons.single() is MigrationBlocker.CredentialRead)
        assertTrue(credentials.writes.isEmpty())
        assertFalse(events.contains("transaction:start"))
        assertFalse(events.contains("dial:release"))
    }

    @Test
    fun nativeCredentialMustReadBackBeforeDatabaseMigrationOrRetirementEligibility() {
        val events = mutableListOf<String>()
        val rows = connectionRows(inlineToken = null)
        val plan = (MigrationPlanner.plan(LegacyStateDecoder.decode(rows)) as MigrationDecision.Ready).plan
        val result = MigrationCoordinator(
            inventory = inventory(rows, events),
            secrets = RecordingSecrets(
                mapOf(LegacySecureStoreKeys.tokenKey(CONNECTION_ID) to LegacySecureValue.Found("pairing")),
                events,
            ),
            credentials = RecordingCredentialStore(CredentialWriteVerification.Failed("read-back mismatch"), events),
            store = RecordingStore(plan.nativeFingerprint, events),
            dialGate = RecordingDialGate(events),
        ).run()

        assertTrue(result is StartupMigrationState.Blocked)
        assertTrue((result as StartupMigrationState.Blocked).reasons.single() is MigrationBlocker.CredentialWrite)
        assertFalse(events.contains("transaction:start"))
        assertFalse(events.contains("dial:release"))
    }

    @Test
    fun inventoryAndDecodeFailuresAreOfflineSafeAndNeverReleaseDialing() {
        val inventoryFailure = LegacyInventoryFailure(LegacyInventoryFailure.Kind.WAL, "missing WAL")
        val events = mutableListOf<String>()
        val result = MigrationCoordinator(
            inventory = LegacyInventorySource {
                events += "inventory"
                LegacyInventoryResult.Failed(listOf(inventoryFailure), linkedMapOf())
            },
            secrets = RecordingSecrets(emptyMap(), events),
            credentials = RecordingCredentialStore(CredentialWriteVerification.Verified, events),
            store = RecordingStore("unused", events),
            dialGate = RecordingDialGate(events),
        ).run()

        assertEquals(
            StartupMigrationState.Blocked(listOf(MigrationBlocker.Inventory(inventoryFailure))),
            result,
        )
        assertTrue(result.offlineSafe)
        assertEquals(listOf("inventory"), events)

        val decodeEvents = mutableListOf<String>()
        val decodeResult = MigrationCoordinator(
            inventory = inventory(
                mapOf("sb-connections" to """{"state":{"configs":[{"id":"broken"}]}}"""),
                decodeEvents,
            ),
            secrets = RecordingSecrets(emptyMap(), decodeEvents),
            credentials = RecordingCredentialStore(CredentialWriteVerification.Verified, decodeEvents),
            store = RecordingStore("unused", decodeEvents),
            dialGate = RecordingDialGate(decodeEvents),
        ).run()
        assertTrue(decodeResult is StartupMigrationState.Blocked)
        assertTrue((decodeResult as StartupMigrationState.Blocked).reasons.all { it is MigrationBlocker.Decode })
        assertEquals(listOf("inventory"), decodeEvents)
    }

    @Test
    fun matchingCheckpointSkipsLegacySecretsAndWritesButStillReleasesDialing() {
        val events = mutableListOf<String>()
        val rows = connectionRows(inlineToken = "inline")
        val plan = (MigrationPlanner.plan(LegacyStateDecoder.decode(rows)) as MigrationDecision.Ready).plan
        val result = MigrationCoordinator(
            inventory = inventory(rows, events),
            secrets = RecordingSecrets(emptyMap(), events),
            credentials = RecordingCredentialStore(CredentialWriteVerification.Verified, events),
            store = RecordingStore(plan.nativeFingerprint, events, MigrationCheckpoint.complete(plan)),
            dialGate = RecordingDialGate(events),
        ).run()

        assertEquals(StartupMigrationState.AlreadyComplete(), result)
        assertEquals(listOf("inventory", "checkpoint", "dial:release"), events)
    }

    @Test
    fun databaseVerificationFailureNeverReleasesDialing() {
        val events = mutableListOf<String>()
        val rows = connectionRows(inlineToken = "inline")
        val result = MigrationCoordinator(
            inventory = inventory(rows, events),
            secrets = RecordingSecrets(emptyMap(), events),
            credentials = RecordingCredentialStore(CredentialWriteVerification.Verified, events),
            store = RecordingStore("wrong", events),
            dialGate = RecordingDialGate(events),
        ).run()

        assertTrue(result is StartupMigrationState.Blocked)
        assertTrue((result as StartupMigrationState.Blocked).reasons.single() is MigrationBlocker.Execution)
        assertFalse(events.contains("dial:release"))
    }

    private fun inventory(rows: Map<String, String>, events: MutableList<String>) = LegacyInventorySource {
        events += "inventory"
        LegacyInventoryResult.Success(LinkedHashMap(rows))
    }

    private fun connectionRows(inlineToken: String?): Map<String, String> {
        val token = inlineToken?.let { ",\"token\":\"$it\"" }.orEmpty()
        return mapOf(
            "sb-connections" to
                """{"state":{"configs":[{"id":"$CONNECTION_ID","label":"Mac","kind":"ws","url":"ws://mac.local:4010"$token}]},"version":0}""",
        )
    }

    private fun assertOrdered(events: List<String>, vararg expected: String) {
        var previous = -1
        for (event in expected) {
            val index = events.indexOf(event)
            assertTrue("missing $event in $events", index >= 0)
            assertTrue("$event was out of order in $events", index > previous)
            previous = index
        }
    }

    private class RecordingSecrets(
        private val values: Map<String, LegacySecureValue>,
        private val events: MutableList<String>,
    ) : LegacySecretReader {
        override fun read(logicalKey: String): LegacySecureValue {
            events += "secret:$logicalKey"
            return values[logicalKey] ?: LegacySecureValue.Missing
        }
    }

    private class RecordingCredentialStore(
        private val result: CredentialWriteVerification,
        private val events: MutableList<String>,
    ) : NativeCredentialStore {
        val writes = mutableListOf<Pair<String, SelectedCredential.Present>>()

        override fun writeAndVerify(
            connectionId: String,
            credential: SelectedCredential.Present,
        ): CredentialWriteVerification {
            events += "credential:$connectionId"
            writes += connectionId to credential
            return result
        }
    }

    private class RecordingStore(
        private val verifiedFingerprint: String,
        private val events: MutableList<String>,
        private var savedCheckpoint: MigrationCheckpoint? = null,
    ) : NativeMigrationStore {
        override fun checkpoint(): MigrationCheckpoint? {
            events += "checkpoint"
            return savedCheckpoint
        }

        override fun <T> transaction(block: (NativeMigrationTransaction) -> T): T {
            events += "transaction:start"
            val transaction = object : NativeMigrationTransaction {
                override fun upsert(write: NativeMigrationWrite.Upsert) {
                    events += "upsert"
                }

                override fun contentFingerprint(): String {
                    events += "database:verify"
                    return verifiedFingerprint
                }

                override fun markComplete(checkpoint: MigrationCheckpoint) {
                    events += "checkpoint:complete"
                    savedCheckpoint = checkpoint
                }
            }
            return block(transaction)
        }
    }

    private class RecordingDialGate(private val events: MutableList<String>) : DialGate {
        override fun release() {
            events += "dial:release"
        }
    }

    private companion object {
        const val CONNECTION_ID = "lan-main"
    }
}
