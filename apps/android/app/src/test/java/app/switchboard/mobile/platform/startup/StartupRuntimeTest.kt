package app.switchboard.mobile.platform.startup

import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.platform.migration.LegacyCredentialRetirement
import app.switchboard.mobile.platform.migration.LegacyInventoryFailure
import app.switchboard.mobile.platform.migration.MigrationBlocker
import app.switchboard.mobile.platform.migration.StartupMigrationState
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class StartupRuntimeTest {
    @Test
    fun concurrentStartsScheduleExactlyOneOffMainMigration() {
        val executor = QueuedExecutor()
        val runs = AtomicInteger()
        var migrationThread: Thread? = null
        val runtime = StartupRuntime(
            executor = executor,
            migration = StartupMigrationRunner {
                runs.incrementAndGet()
                migrationThread = Thread.currentThread()
                StartupMigrationState.AlreadyComplete()
            },
            snapshot = OfflineSnapshotReader(::emptySnapshot),
            dialGate = StartupDialGate {},
        )
        val callersDone = CountDownLatch(12)
        repeat(12) {
            thread {
                runtime.start()
                callersDone.countDown()
            }
        }
        assertTrue(callersDone.await(2, TimeUnit.SECONDS))

        assertEquals(1, executor.tasks.size)
        assertEquals(StartupRuntimeState.Loading, runtime.state)
        val callerThread = Thread.currentThread()
        val worker = thread(name = "startup-test-worker") { executor.runNext() }
        worker.join()

        assertEquals(1, runs.get())
        assertNotEquals(callerThread, migrationThread)
        assertTrue(runtime.state is StartupRuntimeState.Ready)
    }

    @Test
    fun readyPublishesOfflineSnapshotAndRetirementCandidatesBeforeReleasingDialing() {
        val events = mutableListOf<String>()
        val retirement = LegacyCredentialRetirement("lan", "sb-session-lan")
        val snapshot = emptySnapshot()
        val runtime = StartupRuntime(
            executor = Executor { it.run() },
            migration = StartupMigrationRunner {
                events += "migration"
                StartupMigrationState.Ready(listOf(retirement))
            },
            snapshot = OfflineSnapshotReader {
                events += "snapshot"
                snapshot
            },
            dialGate = StartupDialGate { events += "dial" },
        )

        runtime.start()

        assertEquals(listOf("migration", "snapshot", "dial"), events)
        assertEquals(StartupRuntimeState.Ready(snapshot, listOf(retirement)), runtime.state)
    }

    @Test
    fun blockedMigrationExposesRecoveryAndNeverReadsSnapshotOrReleasesDialing() {
        var snapshotRead = false
        var dialReleased = false
        val failure = LegacyInventoryFailure(LegacyInventoryFailure.Kind.WAL, "legacy WAL unavailable")
        val runtime = StartupRuntime(
            executor = Executor { it.run() },
            migration = StartupMigrationRunner {
                StartupMigrationState.Blocked(listOf(MigrationBlocker.Inventory(failure)))
            },
            snapshot = OfflineSnapshotReader {
                snapshotRead = true
                emptySnapshot()
            },
            dialGate = StartupDialGate { dialReleased = true },
        )

        runtime.start()

        val blocked = runtime.state as StartupRuntimeState.Blocked
        assertEquals(StartupRecovery.Stage.MIGRATION, blocked.recovery.stage)
        assertEquals(listOf(MigrationBlocker.Inventory(failure)), blocked.recovery.migrationBlockers)
        assertTrue(blocked.recovery.retryOnNextProcessStart)
        assertFalse(snapshotRead)
        assertFalse(dialReleased)
    }

    @Test
    fun snapshotOrDialFailureBecomesBlockedWithoutPublishingReady() {
        val snapshotFailure = StartupRuntime(
            executor = Executor { it.run() },
            migration = StartupMigrationRunner { StartupMigrationState.AlreadyComplete() },
            snapshot = OfflineSnapshotReader { error("database unavailable") },
            dialGate = StartupDialGate { error("must stay closed") },
        )
        snapshotFailure.start()
        assertEquals(
            StartupRecovery.Stage.OFFLINE_SNAPSHOT,
            (snapshotFailure.state as StartupRuntimeState.Blocked).recovery.stage,
        )

        val dialFailure = StartupRuntime(
            executor = Executor { it.run() },
            migration = StartupMigrationRunner { StartupMigrationState.AlreadyComplete() },
            snapshot = OfflineSnapshotReader(::emptySnapshot),
            dialGate = StartupDialGate { error("dial bootstrap failed") },
        )
        dialFailure.start()
        assertEquals(
            StartupRecovery.Stage.DIAL_RELEASE,
            (dialFailure.state as StartupRuntimeState.Blocked).recovery.stage,
        )
    }

    @Test
    fun blockedStartupCanBeRetriedWithoutRecreatingTheProcess() {
        val runs = AtomicInteger()
        val runtime = StartupRuntime.direct(
            migration = StartupMigrationRunner {
                if (runs.incrementAndGet() == 1) error("database temporarily unavailable")
                StartupMigrationState.AlreadyComplete()
            },
            snapshot = OfflineSnapshotReader(::emptySnapshot),
            dialGate = StartupDialGate {},
        )

        runtime.start()
        assertTrue(runtime.state is StartupRuntimeState.Blocked)

        runtime.start()

        assertEquals(2, runs.get())
        assertTrue(runtime.state is StartupRuntimeState.Ready)
    }

    @Test
    fun processRecreationRerunsTheIdempotentCoordinatorButNeverDuplicatesWithinAProcess() {
        val runs = AtomicInteger()
        val migration = StartupMigrationRunner {
            if (runs.getAndIncrement() == 0) StartupMigrationState.Ready()
            else StartupMigrationState.AlreadyComplete()
        }
        val first = StartupRuntime.direct(migration, OfflineSnapshotReader(::emptySnapshot), StartupDialGate {})
        first.start()
        first.start()

        val recreated = StartupRuntime.direct(migration, OfflineSnapshotReader(::emptySnapshot), StartupDialGate {})
        recreated.start()
        recreated.start()

        assertEquals(2, runs.get())
        assertTrue(first.state is StartupRuntimeState.Ready)
        assertTrue(recreated.state is StartupRuntimeState.Ready)
    }

    private class QueuedExecutor : Executor {
        val tasks = mutableListOf<Runnable>()

        @Synchronized
        override fun execute(command: Runnable) {
            tasks += command
        }

        fun runNext() = tasks.removeAt(0).run()
    }
}

private fun emptySnapshot() = OfflineSnapshot(
    connections = emptyList(),
    credentialRefs = emptyList(),
    nativeCredentialRefs = emptyList(),
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
