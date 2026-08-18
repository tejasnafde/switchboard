package app.switchboard.mobile.platform.startup

import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.domain.google.GoogleCredentialBundle
import app.switchboard.mobile.platform.google.GoogleCredentialReadResult
import app.switchboard.mobile.platform.google.GoogleLegacyMigrationResult
import app.switchboard.mobile.platform.migration.LegacyInventoryFailure
import app.switchboard.mobile.platform.migration.MigrationBlocker
import app.switchboard.mobile.platform.migration.StartupMigrationState
import java.util.concurrent.Executor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GoogleStartupRuntimeTest {
    @Test
    fun `Google import runs after core migration and before snapshot and ordinary dialing`() {
        val events = mutableListOf<String>()
        val google = GoogleStartupCoordinator(
            migration = GoogleStartupMigrationRunner {
                events += "google"
                GoogleLegacyMigrationResult.Migrated
            },
            credentials = availableCredentials(),
        )
        val runtime = StartupRuntime(
            executor = Executor(Runnable::run),
            migration = GoogleAwareStartupMigrationRunner(
                core = StartupMigrationRunner {
                    events += "core"
                    StartupMigrationState.AlreadyComplete()
                },
                google = google,
            ),
            snapshot = OfflineSnapshotReader {
                events += "snapshot"
                emptySnapshot()
            },
            dialGate = StartupDialGate { events += "dial" },
        )

        runtime.start()

        assertEquals(listOf("core", "google", "snapshot", "dial"), events)
        assertEquals(GoogleStartupState.Ready, google.state)
        assertTrue(google.isGoogleNetworkAllowed)
        assertTrue(runtime.state is StartupRuntimeState.Ready)
    }

    @Test
    fun `absent Google credentials do not block ordinary websocket startup`() {
        val dialed = mutableListOf<String>()
        val google = GoogleStartupCoordinator(
            migration = GoogleStartupMigrationRunner { GoogleLegacyMigrationResult.NothingToMigrate },
            credentials = GoogleStartupCredentialReader { GoogleCredentialReadResult.Absent },
        )
        val runtime = readyRuntime(google) { dialed += "dial" }

        runtime.start()

        assertEquals(GoogleStartupState.Absent, google.state)
        assertFalse(google.isGoogleNetworkAllowed)
        assertEquals(listOf("dial"), dialed)
        assertTrue(runtime.state is StartupRuntimeState.Ready)
    }

    @Test
    fun `blocked Google migration publishes fixed safe copy but ordinary websocket still starts`() {
        var dialed = false
        val google = GoogleStartupCoordinator(
            migration = GoogleStartupMigrationRunner {
                GoogleLegacyMigrationResult.Blocked("refresh token 1//must-never-surface")
            },
            credentials = GoogleStartupCredentialReader {
                error("blocked migration must not inspect or expose credentials")
            },
        )
        val runtime = readyRuntime(google) { dialed = true }

        runtime.start()

        assertEquals(
            GoogleStartupState.Blocked("Google credentials could not be prepared safely"),
            google.state,
        )
        assertFalse((google.state as GoogleStartupState.Blocked).reason.contains("1//"))
        assertFalse(google.isGoogleNetworkAllowed)
        assertTrue(dialed)
        assertTrue(runtime.state is StartupRuntimeState.Ready)
    }

    @Test
    fun `core migration failure skips Google work and keeps every network gate closed`() {
        var googleRuns = 0
        var dialed = false
        val google = GoogleStartupCoordinator(
            migration = GoogleStartupMigrationRunner {
                googleRuns++
                GoogleLegacyMigrationResult.Migrated
            },
            credentials = availableCredentials(),
        )
        val failure = LegacyInventoryFailure(LegacyInventoryFailure.Kind.READ, "core unavailable")
        val runtime = StartupRuntime.direct(
            migration = GoogleAwareStartupMigrationRunner(
                core = StartupMigrationRunner {
                    StartupMigrationState.Blocked(listOf(MigrationBlocker.Inventory(failure)))
                },
                google = google,
            ),
            snapshot = OfflineSnapshotReader(::emptySnapshot),
            dialGate = StartupDialGate { dialed = true },
        )

        runtime.start()

        assertEquals(0, googleRuns)
        assertEquals(GoogleStartupState.Pending, google.state)
        assertFalse(google.isGoogleNetworkAllowed)
        assertFalse(dialed)
        assertTrue(runtime.state is StartupRuntimeState.Blocked)
    }

    @Test
    fun `prepared migration opens the gate only when native credentials are actually readable`() {
        val existing = GoogleStartupCoordinator(
            migration = GoogleStartupMigrationRunner { GoogleLegacyMigrationResult.ExistingNative },
            credentials = availableCredentials(),
        )
        existing.run()
        assertEquals(GoogleStartupState.Ready, existing.state)
        assertTrue(existing.isGoogleNetworkAllowed)

        val signedOut = GoogleStartupCoordinator(
            migration = GoogleStartupMigrationRunner { GoogleLegacyMigrationResult.AlreadyComplete },
            credentials = GoogleStartupCredentialReader { GoogleCredentialReadResult.Absent },
        )
        signedOut.run()
        assertEquals(GoogleStartupState.Absent, signedOut.state)
        assertFalse(signedOut.isGoogleNetworkAllowed)

        val unreadable = GoogleStartupCoordinator(
            migration = GoogleStartupMigrationRunner { GoogleLegacyMigrationResult.AlreadyComplete },
            credentials = GoogleStartupCredentialReader {
                GoogleCredentialReadResult.Blocked("secret-bearing platform detail")
            },
        )
        unreadable.run()
        assertEquals(
            GoogleStartupState.Blocked("Google credentials could not be prepared safely"),
            unreadable.state,
        )
        assertFalse(unreadable.isGoogleNetworkAllowed)
    }

    private fun availableCredentials() = GoogleStartupCredentialReader {
        GoogleCredentialReadResult.Available(
            GoogleCredentialBundle(clientId = "client", refreshToken = "1//refresh"),
        )
    }

    private fun readyRuntime(
        google: GoogleStartupCoordinator,
        dial: () -> Unit,
    ) = StartupRuntime.direct(
        migration = GoogleAwareStartupMigrationRunner(
            core = StartupMigrationRunner { StartupMigrationState.AlreadyComplete() },
            google = google,
        ),
        snapshot = OfflineSnapshotReader(::emptySnapshot),
        dialGate = StartupDialGate(dial),
    )
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
