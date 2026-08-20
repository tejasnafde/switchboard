package app.switchboard.mobile.platform.startup

import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.platform.migration.LegacyCredentialRetirement
import app.switchboard.mobile.platform.migration.MigrationBlocker
import app.switchboard.mobile.platform.migration.StartupMigrationState
import java.io.Closeable
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executor

fun interface StartupMigrationRunner {
    fun run(): StartupMigrationState
}

fun interface OfflineSnapshotReader {
    fun read(): OfflineSnapshot
}

fun interface StartupDialGate {
    fun release()
}

sealed interface StartupRuntimeState {
    data object Loading : StartupRuntimeState

    data class Ready(
        val offlineSnapshot: OfflineSnapshot,
        val retirementCandidates: List<LegacyCredentialRetirement>,
    ) : StartupRuntimeState

    data class Blocked(val recovery: StartupRecovery) : StartupRuntimeState
}

data class StartupRecovery(
    val stage: Stage,
    val detail: String,
    val migrationBlockers: List<MigrationBlocker> = emptyList(),
    val retryOnNextProcessStart: Boolean = true,
) {
    enum class Stage { SCHEDULING, MIGRATION, OFFLINE_SNAPSHOT, DIAL_RELEASE }
}

class StartupRuntime(
    private val executor: Executor,
    private val migration: StartupMigrationRunner,
    private val snapshot: OfflineSnapshotReader,
    private val dialGate: StartupDialGate,
) {
    @Volatile
    var state: StartupRuntimeState = StartupRuntimeState.Loading
        private set

    private val observers = CopyOnWriteArraySet<(StartupRuntimeState) -> Unit>()
    private var started = false

    @Synchronized
    fun start() {
        if (started && state !is StartupRuntimeState.Blocked) return
        started = true
        if (state is StartupRuntimeState.Blocked) {
            publish(StartupRuntimeState.Loading)
        }
        try {
            executor.execute { runStartup() }
        } catch (error: Exception) {
            publish(
                StartupRuntimeState.Blocked(
                    StartupRecovery(
                        stage = StartupRecovery.Stage.SCHEDULING,
                        detail = error.message ?: "startup worker could not be scheduled",
                    ),
                ),
            )
        }
    }

    fun observe(observer: (StartupRuntimeState) -> Unit): Closeable {
        observers += observer
        observer(state)
        return Closeable { observers -= observer }
    }

    private fun runStartup() {
        val migrationState = try {
            migration.run()
        } catch (error: Exception) {
            publish(blocked(StartupRecovery.Stage.MIGRATION, error, "startup migration failed"))
            return
        }

        val retirements = when (migrationState) {
            is StartupMigrationState.Ready -> migrationState.retirementCandidates
            is StartupMigrationState.AlreadyComplete -> emptyList()
            is StartupMigrationState.Blocked -> {
                publish(
                    StartupRuntimeState.Blocked(
                        StartupRecovery(
                            stage = StartupRecovery.Stage.MIGRATION,
                            detail = "legacy data could not be migrated safely",
                            migrationBlockers = migrationState.reasons,
                        ),
                    ),
                )
                return
            }
        }

        val offlineSnapshot = try {
            snapshot.read()
        } catch (error: Exception) {
            publish(blocked(StartupRecovery.Stage.OFFLINE_SNAPSHOT, error, "offline data could not be loaded"))
            return
        }

        try {
            dialGate.release()
        } catch (error: Exception) {
            publish(blocked(StartupRecovery.Stage.DIAL_RELEASE, error, "network startup could not be released"))
            return
        }
        publish(StartupRuntimeState.Ready(offlineSnapshot, retirements))
    }

    private fun blocked(
        stage: StartupRecovery.Stage,
        error: Exception,
        fallback: String,
    ) = StartupRuntimeState.Blocked(
        StartupRecovery(
            stage = stage,
            detail = error.message?.takeIf(String::isNotBlank) ?: fallback,
        ),
    )

    private fun publish(next: StartupRuntimeState) {
        state = next
        observers.forEach { observer -> observer(next) }
    }

    companion object {
        fun direct(
            migration: StartupMigrationRunner,
            snapshot: OfflineSnapshotReader,
            dialGate: StartupDialGate,
        ) = StartupRuntime(Executor { command -> command.run() }, migration, snapshot, dialGate)
    }
}
