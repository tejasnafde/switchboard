package app.switchboard.mobile.platform.google

import app.switchboard.mobile.compat.LegacySecureStoreKeys
import app.switchboard.mobile.domain.google.GoogleCredentialBundle
import app.switchboard.mobile.platform.migration.LegacySecretReader
import app.switchboard.mobile.platform.migration.LegacySecureValue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GoogleLegacyCredentialMigratorTest {
    @Test
    fun `reads every canonical key and checkpoints only after verified native write`() {
        val secrets = RecordingSecrets(
            mapOf(
                REFRESH to LegacySecureValue.Found("1//refresh"),
                ACCESS to LegacySecureValue.Found("access"),
                EXPIRES to LegacySecureValue.Found("123456"),
                EMAIL to LegacySecureValue.Found("person@example.com"),
                CLIENT_ID to LegacySecureValue.Found("client"),
                CLIENT_SECRET to LegacySecureValue.Found("secret"),
            ),
        )
        val native = FakeNativeStore()
        val checkpoint = FakeCheckpoint()

        val result = GoogleLegacyCredentialMigrator(secrets, native, checkpoint).migrate()

        assertEquals(GoogleLegacyMigrationResult.Migrated, result)
        assertEquals(LegacySecureStoreKeys.GOOGLE_KEYS, secrets.reads)
        assertEquals(
            GoogleCredentialBundle("client", "secret", "1//refresh", "access", 123_456, "person@example.com"),
            native.bundle,
        )
        assertTrue(checkpoint.complete)
    }

    @Test
    fun `completed migration is idempotent and cannot resurrect signed-out legacy credentials`() {
        val secrets = RecordingSecrets(
            mapOf(
                REFRESH to LegacySecureValue.Found("1//legacy"),
                CLIENT_ID to LegacySecureValue.Found("legacy-client"),
            ),
        )
        val native = FakeNativeStore()
        val checkpoint = FakeCheckpoint(complete = true)

        assertEquals(
            GoogleLegacyMigrationResult.AlreadyComplete,
            GoogleLegacyCredentialMigrator(secrets, native, checkpoint).migrate(),
        )
        assertTrue(secrets.reads.isEmpty())
        assertEquals(0, native.writeCalls)
    }

    @Test
    fun `existing native identity wins without reading or changing legacy storage`() {
        val existing = GoogleCredentialBundle("native-client", refreshToken = "1//native")
        val secrets = RecordingSecrets(emptyMap())
        val native = FakeNativeStore(existing)
        val checkpoint = FakeCheckpoint()

        assertEquals(
            GoogleLegacyMigrationResult.ExistingNative,
            GoogleLegacyCredentialMigrator(secrets, native, checkpoint).migrate(),
        )
        assertTrue(secrets.reads.isEmpty())
        assertEquals(existing, native.bundle)
        assertTrue(checkpoint.complete)
    }

    @Test
    fun `only an entirely absent legacy footprint is checkpointed as nothing to migrate`() {
        val noIdentityCheckpoint = FakeCheckpoint()
        assertEquals(
            GoogleLegacyMigrationResult.NothingToMigrate,
            GoogleLegacyCredentialMigrator(
                RecordingSecrets(emptyMap()),
                FakeNativeStore(),
                noIdentityCheckpoint,
            ).migrate(),
        )
        assertTrue(noIdentityCheckpoint.complete)
    }

    @Test
    fun `partial identity blank required fields and malformed expiry remain recoverable blockers`() {
        val partialCheckpoint = FakeCheckpoint()
        assertTrue(
            GoogleLegacyCredentialMigrator(
                RecordingSecrets(mapOf(REFRESH to LegacySecureValue.Found("1//refresh"))),
                FakeNativeStore(),
                partialCheckpoint,
            ).migrate() is GoogleLegacyMigrationResult.Blocked,
        )
        assertFalse(partialCheckpoint.complete)

        val blankRequiredCheckpoint = FakeCheckpoint()
        assertTrue(
            GoogleLegacyCredentialMigrator(
                RecordingSecrets(
                    mapOf(
                        REFRESH to LegacySecureValue.Found("  "),
                        CLIENT_ID to LegacySecureValue.Found("client"),
                    ),
                ),
                FakeNativeStore(),
                blankRequiredCheckpoint,
            ).migrate() is GoogleLegacyMigrationResult.Blocked,
        )
        assertFalse(blankRequiredCheckpoint.complete)

        val invalidExpiry = RecordingSecrets(
            mapOf(
                REFRESH to LegacySecureValue.Found("1//refresh"),
                CLIENT_ID to LegacySecureValue.Found("client"),
                EXPIRES to LegacySecureValue.Found("not-a-number"),
            ),
        )
        val invalidExpiryCheckpoint = FakeCheckpoint()
        assertTrue(
            GoogleLegacyCredentialMigrator(
                invalidExpiry,
                FakeNativeStore(),
                invalidExpiryCheckpoint,
            ).migrate() is GoogleLegacyMigrationResult.Blocked,
        )
        assertFalse(invalidExpiryCheckpoint.complete)
    }

    @Test
    fun `unreadable legacy key or failed verification never checkpoints`() {
        val unreadable = RecordingSecrets(
            mapOf(
                REFRESH to LegacySecureValue.Found("1//refresh"),
                CLIENT_ID to LegacySecureValue.Failure(
                    LegacySecureValue.Failure.Kind.KEY_UNAVAILABLE,
                    "locked",
                ),
            ),
        )
        val unreadableCheckpoint = FakeCheckpoint()
        assertTrue(
            GoogleLegacyCredentialMigrator(unreadable, FakeNativeStore(), unreadableCheckpoint).migrate() is
                GoogleLegacyMigrationResult.Blocked,
        )
        assertFalse(unreadableCheckpoint.complete)

        val coherent = RecordingSecrets(
            mapOf(
                REFRESH to LegacySecureValue.Found("1//refresh"),
                CLIENT_ID to LegacySecureValue.Found("client"),
            ),
        )
        val failedCheckpoint = FakeCheckpoint()
        assertTrue(
            GoogleLegacyCredentialMigrator(
                coherent,
                FakeNativeStore(writeResult = GoogleCredentialWriteResult.Failed("verification failed")),
                failedCheckpoint,
            ).migrate() is GoogleLegacyMigrationResult.Blocked,
        )
        assertFalse(failedCheckpoint.complete)
    }

    @Test
    fun `unreadable native identity blocks before any legacy key is read`() {
        val secrets = RecordingSecrets(
            mapOf(
                REFRESH to LegacySecureValue.Found("1//legacy"),
                CLIENT_ID to LegacySecureValue.Found("legacy-client"),
            ),
        )
        val native = FakeNativeStore(
            readResult = GoogleCredentialReadResult.Blocked("native credential key is unavailable"),
        )
        val checkpoint = FakeCheckpoint()

        assertTrue(
            GoogleLegacyCredentialMigrator(secrets, native, checkpoint).migrate() is
                GoogleLegacyMigrationResult.Blocked,
        )
        assertTrue(secrets.reads.isEmpty())
        assertEquals(0, native.writeCalls)
        assertFalse(checkpoint.complete)
    }

    @Test
    fun `checkpoint write failure is retryable without overwriting native identity`() {
        val secrets = RecordingSecrets(
            mapOf(
                REFRESH to LegacySecureValue.Found("1//refresh"),
                CLIENT_ID to LegacySecureValue.Found("client"),
            ),
        )
        val native = FakeNativeStore()
        val checkpoint = FakeCheckpoint(markSucceeds = false)
        assertTrue(
            GoogleLegacyCredentialMigrator(secrets, native, checkpoint).migrate() is
                GoogleLegacyMigrationResult.Blocked,
        )

        checkpoint.markSucceeds = true
        assertEquals(
            GoogleLegacyMigrationResult.ExistingNative,
            GoogleLegacyCredentialMigrator(secrets, native, checkpoint).migrate(),
        )
        assertEquals(1, native.writeCalls)
    }

    private class RecordingSecrets(
        private val values: Map<String, LegacySecureValue>,
    ) : LegacySecretReader {
        val reads = mutableListOf<String>()

        override fun read(logicalKey: String): LegacySecureValue {
            reads += logicalKey
            return values[logicalKey] ?: LegacySecureValue.Missing
        }
    }

    private class FakeNativeStore(
        initialBundle: GoogleCredentialBundle? = null,
        private val writeResult: GoogleCredentialWriteResult = GoogleCredentialWriteResult.Verified,
        private var readResult: GoogleCredentialReadResult = initialBundle?.let(GoogleCredentialReadResult::Available)
            ?: GoogleCredentialReadResult.Absent,
    ) : GoogleNativeCredentialStore {
        var writeCalls = 0

        override val bundle: GoogleCredentialBundle?
            get() = (readResult as? GoogleCredentialReadResult.Available)?.credentials

        override fun readStatus(): GoogleCredentialReadResult = readResult

        override fun writeAndVerify(credentials: GoogleCredentialBundle): GoogleCredentialWriteResult {
            writeCalls++
            if (writeResult == GoogleCredentialWriteResult.Verified) {
                readResult = GoogleCredentialReadResult.Available(credentials)
            }
            return writeResult
        }

        override fun replace(expected: GoogleCredentialBundle, replacement: GoogleCredentialBundle): Boolean = false

        override fun clearNativeOwned(expected: GoogleCredentialBundle?): Boolean = false
    }

    private class FakeCheckpoint(
        override var complete: Boolean = false,
        var markSucceeds: Boolean = true,
    ) : GoogleMigrationCheckpointStore {
        override fun markComplete(): Boolean {
            if (markSucceeds) complete = true
            return markSucceeds
        }
    }

    private companion object {
        const val REFRESH = "sb.google.refresh_token"
        const val ACCESS = "sb.google.access_token"
        const val EXPIRES = "sb.google.expires_at"
        const val EMAIL = "sb.google.email"
        const val CLIENT_ID = "sb.google.client_id"
        const val CLIENT_SECRET = "sb.google.client_secret"
    }
}
