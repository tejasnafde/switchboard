package app.switchboard.mobile.platform.startup

import app.switchboard.mobile.platform.google.GoogleLegacyMigrationResult
import app.switchboard.mobile.platform.google.GoogleCredentialReadResult
import app.switchboard.mobile.platform.migration.StartupMigrationState
import java.io.Closeable
import java.util.concurrent.CopyOnWriteArraySet

fun interface GoogleStartupMigrationRunner {
    fun run(): GoogleLegacyMigrationResult
}

fun interface GoogleStartupCredentialReader {
    fun read(): GoogleCredentialReadResult
}

sealed interface GoogleStartupState {
    data object Pending : GoogleStartupState
    data object Ready : GoogleStartupState
    data object Absent : GoogleStartupState
    data class Blocked(val reason: String) : GoogleStartupState
}

class GoogleStartupCoordinator(
    private val migration: GoogleStartupMigrationRunner,
    private val credentials: GoogleStartupCredentialReader,
) {
    @Volatile
    var state: GoogleStartupState = GoogleStartupState.Pending
        private set

    val isGoogleNetworkAllowed: Boolean
        get() = state == GoogleStartupState.Ready

    private val observers = CopyOnWriteArraySet<(GoogleStartupState) -> Unit>()

    @Synchronized
    fun run(): GoogleStartupState {
        if (state != GoogleStartupState.Pending) return state
        val next = try {
            when (migration.run()) {
                GoogleLegacyMigrationResult.Migrated,
                GoogleLegacyMigrationResult.AlreadyComplete,
                GoogleLegacyMigrationResult.ExistingNative,
                -> preparedState()

                GoogleLegacyMigrationResult.NothingToMigrate -> GoogleStartupState.Absent
                is GoogleLegacyMigrationResult.Blocked -> GoogleStartupState.Blocked(BLOCKED_REASON)
            }
        } catch (_: Exception) {
            GoogleStartupState.Blocked(BLOCKED_REASON)
        }
        state = next
        observers.forEach { it(next) }
        return next
    }

    private fun preparedState(): GoogleStartupState = when (credentials.read()) {
        GoogleCredentialReadResult.Absent -> GoogleStartupState.Absent
        is GoogleCredentialReadResult.Available -> GoogleStartupState.Ready
        is GoogleCredentialReadResult.Blocked -> GoogleStartupState.Blocked(BLOCKED_REASON)
    }

    fun observe(observer: (GoogleStartupState) -> Unit): Closeable {
        observers += observer
        observer(state)
        return Closeable { observers -= observer }
    }

    companion object {
        const val BLOCKED_REASON = "Google credentials could not be prepared safely"
    }
}

class GoogleAwareStartupMigrationRunner(
    private val core: StartupMigrationRunner,
    private val google: GoogleStartupCoordinator,
) : StartupMigrationRunner {
    override fun run(): StartupMigrationState {
        val coreState = core.run()
        if (coreState !is StartupMigrationState.Blocked) google.run()
        return coreState
    }
}
