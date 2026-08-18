package app.switchboard.mobile.data

import app.switchboard.mobile.compat.LegacyAsyncStorageDecoder
import app.switchboard.mobile.compat.LegacyStateDecoder
import java.nio.file.Files
import java.nio.file.Path
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MigrationPlannerTest {
    @Test
    fun fixtureProducesOnlyIdempotentUpsertsAndAStableFingerprint() {
        val report = fixtureReport()
        val first = MigrationPlanner.plan(report) as MigrationDecision.Ready
        val second = MigrationPlanner.plan(report) as MigrationDecision.Ready

        assertEquals(first.plan, second.plan)
        assertTrue(first.plan.writes.isNotEmpty())
        assertTrue(first.plan.writes.any { it is NativeMigrationWrite.UpsertOutbox && it.messageId == "turn-text" })
        assertTrue(first.plan.writes.any { it is NativeMigrationWrite.UpsertConnection && it.connectionId == "work-iap" })
        assertFalse(first.plan.sourceFingerprint.isBlank())
        assertFalse(first.plan.nativeFingerprint.isBlank())
    }

    @Test
    fun blockingLegacyIssuesPreventAnyNativeWritePlan() {
        val report = LegacyStateDecoder.decode(
            mapOf(
                "sb-connections" to
                    """{"state":{"configs":[{"id":"broken","label":"VM","kind":"iap","project":"p"}]},"version":0}""",
            ),
        )

        val decision = MigrationPlanner.plan(report)

        assertTrue(decision is MigrationDecision.Blocked)
        assertTrue((decision as MigrationDecision.Blocked).issues.any { it.code == "partial_connection" })
    }

    @Test
    fun transientRuntimeFallbackIsUsedForPresentationButNeverPersistedByMigration() {
        val report = LegacyStateDecoder.decode(
            mapOf("switchboard-prefs" to """{"state":{"threads":{},"collapsedWorkspaces":[]},"version":0}"""),
        )
        val plan = (MigrationPlanner.plan(report) as MigrationDecision.Ready).plan

        assertEquals("sandbox", report.preferences.defaultMode.value)
        assertFalse(plan.writes.any { it is NativeMigrationWrite.UpsertDefaultMode })
    }

    @Test
    fun completionCheckpointIsWrittenOnlyAfterWritesAndFingerprintVerification() {
        val plan = (MigrationPlanner.plan(fixtureReport()) as MigrationDecision.Ready).plan
        val store = RecordingStore(plan.nativeFingerprint)

        val result = MigrationExecutor.execute(plan, store)

        assertEquals(MigrationExecution.MIGRATED, result)
        assertEquals("transaction:start", store.events.first())
        assertTrue(store.events.indexOf("verify") > store.events.indexOfLast { it.startsWith("upsert:") })
        assertTrue(store.events.indexOf("checkpoint") > store.events.indexOf("verify"))
        assertEquals("transaction:commit", store.events.last())
        assertEquals(MigrationCheckpoint.complete(plan), store.savedCheckpoint)
    }

    @Test
    fun failedVerificationNeverWritesACompletionCheckpoint() {
        val plan = (MigrationPlanner.plan(fixtureReport()) as MigrationDecision.Ready).plan
        val store = RecordingStore("wrong-fingerprint")

        val failure = runCatching { MigrationExecutor.execute(plan, store) }.exceptionOrNull()

        assertTrue(failure is MigrationVerificationException)
        assertFalse(store.events.contains("checkpoint"))
        assertEquals(null, store.savedCheckpoint)
    }

    @Test
    fun matchingCompletionCheckpointMakesRerunsNoOps() {
        val plan = (MigrationPlanner.plan(fixtureReport()) as MigrationDecision.Ready).plan
        val store = RecordingStore(plan.nativeFingerprint, MigrationCheckpoint.complete(plan))

        assertEquals(MigrationExecution.ALREADY_COMPLETE, MigrationExecutor.execute(plan, store))
        assertTrue(store.events.isEmpty())
    }

    @Test
    fun aCheckpointForDifferentLegacyBytesBlocksInsteadOfOverwritingNativeState() {
        val plan = (MigrationPlanner.plan(fixtureReport()) as MigrationDecision.Ready).plan
        val checkpoint = MigrationCheckpoint("different-source", "different-native", MigrationCheckpoint.State.COMPLETE)
        val store = RecordingStore(plan.nativeFingerprint, checkpoint)

        val failure = runCatching { MigrationExecutor.execute(plan, store) }.exceptionOrNull()

        assertTrue(failure is MigrationCheckpointConflictException)
        assertTrue(store.events.isEmpty())
    }

    private fun fixtureReport() = LegacyStateDecoder.decode(
        LegacyAsyncStorageDecoder.decode(fixture("async-storage/rkstorage.json")).rows,
    )

    private fun fixture(relative: String): String {
        val path = generateSequence(Path.of("").toAbsolutePath()) { it.parent }
            .map { it.resolve("tests/fixtures/mobile-native").resolve(relative) }
            .firstOrNull(Files::exists)
            ?: error("Missing fixture $relative")
        return String(Files.readAllBytes(path), Charsets.UTF_8)
    }

    private class RecordingStore(
        private val verifiedFingerprint: String,
        initialCheckpoint: MigrationCheckpoint? = null,
    ) : NativeMigrationStore {
        val events = mutableListOf<String>()
        var savedCheckpoint: MigrationCheckpoint? = initialCheckpoint

        override fun checkpoint(): MigrationCheckpoint? = savedCheckpoint

        override fun <T> transaction(block: (NativeMigrationTransaction) -> T): T {
            events += "transaction:start"
            val transaction = object : NativeMigrationTransaction {
                override fun upsert(write: NativeMigrationWrite.Upsert) {
                    events += "upsert:${write.javaClass.simpleName}"
                }

                override fun contentFingerprint(): String {
                    events += "verify"
                    return verifiedFingerprint
                }

                override fun markComplete(checkpoint: MigrationCheckpoint) {
                    events += "checkpoint"
                    savedCheckpoint = checkpoint
                }
            }
            return try {
                block(transaction).also { events += "transaction:commit" }
            } catch (error: Throwable) {
                events += "transaction:rollback"
                throw error
            }
        }
    }
}
