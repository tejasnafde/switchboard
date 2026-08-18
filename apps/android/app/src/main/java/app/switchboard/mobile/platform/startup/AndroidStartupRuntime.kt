package app.switchboard.mobile.platform.startup

import android.content.Context
import app.switchboard.mobile.data.local.RoomNativeMigrationStore
import app.switchboard.mobile.data.local.SwitchboardDatabase
import app.switchboard.mobile.platform.migration.AndroidLegacyDatabaseReader
import app.switchboard.mobile.platform.migration.AndroidSecureStorePlatform
import app.switchboard.mobile.platform.migration.DialGate
import app.switchboard.mobile.platform.migration.ExpoSecureStoreReader
import app.switchboard.mobile.platform.migration.LegacyInventory
import app.switchboard.mobile.platform.migration.MigrationCoordinator
import app.switchboard.mobile.platform.storage.VerifiedNativeCredentialStore
import java.io.Closeable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class AndroidStartupRuntime private constructor(
    context: Context,
    database: SwitchboardDatabase,
    credentials: VerifiedNativeCredentialStore,
    dialGate: DialGate,
) : Closeable {
    private val applicationContext = context.applicationContext
    private val executor = Executors.newSingleThreadExecutor { task ->
        Thread(task, "switchboard-startup").apply { isDaemon = true }
    }
    private val coordinator = MigrationCoordinator(
        inventory = LegacyInventory(AndroidLegacyDatabaseReader(applicationContext)),
        secrets = ExpoSecureStoreReader(AndroidSecureStorePlatform(applicationContext)),
        credentials = credentials,
        store = RoomNativeMigrationStore(database),
        // The coordinator verifies migration first. The runtime releases the real network gate only
        // after the offline snapshot has also been read successfully.
        dialGate = DialGate {},
    )
    private val runtime = StartupRuntime(
        executor = executor,
        migration = StartupMigrationRunner(coordinator::run),
        snapshot = OfflineSnapshotReader(database.offlineSnapshotDao()::read),
        dialGate = StartupDialGate(dialGate::release),
    )

    val state: StartupRuntimeState
        get() = runtime.state

    fun start() = runtime.start()

    fun observe(observer: (StartupRuntimeState) -> Unit): Closeable = runtime.observe(observer)

    override fun close() {
        executor.shutdown()
        val finished = try {
            executor.awaitTermination(CLOSE_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            false
        }
        if (!finished) {
            executor.shutdownNow()
        }
    }

    companion object {
        fun create(
            context: Context,
            database: SwitchboardDatabase,
            credentials: VerifiedNativeCredentialStore,
            dialGate: DialGate,
        ): AndroidStartupRuntime = AndroidStartupRuntime(
            context = context.applicationContext,
            database = database,
            credentials = credentials,
            dialGate = dialGate,
        )

        private const val CLOSE_TIMEOUT_SECONDS = 5L
    }
}
