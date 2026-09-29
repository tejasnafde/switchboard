package app.switchboard.mobile.data.local

import android.content.Context
import android.database.sqlite.SQLiteBlobTooBigException
import android.database.sqlite.SQLiteDatabase
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import app.switchboard.mobile.data.AtomicMigrationPlan
import app.switchboard.mobile.data.MigrationExecution
import app.switchboard.mobile.data.MigrationExecutor
import app.switchboard.mobile.data.NativeMigrationWrite
import app.switchboard.mobile.platform.migration.StartupMigrationState
import app.switchboard.mobile.platform.startup.OfflineSnapshotReader
import app.switchboard.mobile.platform.startup.StartupDialGate
import app.switchboard.mobile.platform.startup.StartupMigrationRunner
import app.switchboard.mobile.platform.startup.StartupRuntime
import app.switchboard.mobile.ui.connections.ConnectionsLoadState
import app.switchboard.mobile.ui.connections.StartupConnectionsMapper
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Real SQLite through Robolectric's native mode, which enforces the same ~2 MB
 * CursorWindow as a phone, so the "Row too big" failure reproduces here.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class OversizedRowRepairTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val huge = "x".repeat(3 * 1024 * 1024)
    private val opened = mutableListOf<SwitchboardDatabase>()

    @Before
    fun reset() {
        context.deleteDatabase(SwitchboardDatabase.DATABASE_NAME)
    }

    @After
    fun close() {
        opened.forEach(SwitchboardDatabase::close)
        context.deleteDatabase(SwitchboardDatabase.DATABASE_NAME)
    }

    @Test
    fun aPhoneAlreadyHoldingARowTooBigForTheCursorWindowIsRepairedOnTheNextOpen() {
        seedOversizedRowsWithoutRepair(includeNonCacheRows = true)
        assertThrows(SQLiteBlobTooBigException::class.java) {
            rawQueryAll("SELECT * FROM cached_feed_rows")
        }

        val warnings = mutableListOf<String>()
        val repairing = unrepaired()
        val dropped = OversizedRowRepair.run(repairing.openHelper.writableDatabase, warnings::add)
        repairing.close()

        assertEquals(
            listOf(
                OversizedRowRepair.Dropped("cached_threads", 1, huge.length.toLong()),
                OversizedRowRepair.Dropped("cached_feed_rows", 1, huge.length.toLong()),
                OversizedRowRepair.Dropped("browse_snapshots", 1, huge.length.toLong()),
                OversizedRowRepair.Dropped("outbox", 1, huge.length.toLong()),
                OversizedRowRepair.Dropped("thread_preferences", 1, huge.length.toLong()),
            ),
            dropped,
        )
        assertTrue(warnings.none { "xxxx" in it })
        assertEquals(5, warnings.size)

        val snapshot = open().offlineSnapshotDao().read()
        assertEquals(listOf("lan"), snapshot.connections.map { it.id })
        assertEquals(listOf("lan:small"), snapshot.cachedThreads.map { it.threadKey })
        assertEquals(listOf("small-row"), snapshot.feedRows.map { it.itemId })
        assertEquals(listOf("small-browse"), snapshot.browseSnapshots.map { it.snapshotKey })
        assertTrue(snapshot.outbox.isEmpty())
        assertNull(snapshot.threadPreferences.single().draft)
    }

    @Test
    fun theProductionOpenRunsTheRepairBeforeTheFirstRead() {
        seedOversizedRowsWithoutRepair()

        val runtime = StartupRuntime.direct(
            migration = StartupMigrationRunner { StartupMigrationState.AlreadyComplete() },
            snapshot = OfflineSnapshotReader(open().offlineSnapshotDao()::read),
            dialGate = StartupDialGate {},
        )
        runtime.start()

        val machines = StartupConnectionsMapper.map(runtime.state) as ConnectionsLoadState.Ready
        assertEquals(listOf("lan"), machines.connections.map { it.id })
        assertEquals(0L, raw { db -> countOver(db, "cached_feed_rows") })
    }

    @Test
    fun anUnrepairedOversizedCacheRowCostsOnlyThatRowNotTheMachinesList() {
        seedOversizedRowsWithoutRepair()
        val database = unrepaired()

        val snapshot = database.offlineSnapshotDao().read()

        assertEquals(listOf("lan"), snapshot.connections.map { it.id })
        assertEquals(listOf("lan:small"), snapshot.cachedThreads.map { it.threadKey })
        assertEquals(listOf("small-row"), snapshot.feedRows.map { it.itemId })
        assertEquals(listOf("small-browse"), snapshot.browseSnapshots.map { it.snapshotKey })
        assertTrue(database.browseSnapshotDao().forConnection("lan").none { it.snapshotKey == "huge-browse" })
        assertNull(database.cacheDao().findThread("lan:huge"))
    }

    @Test
    fun aCacheTableThatCannotBeReadAtAllDegradesToNoCache() {
        val database = open()
        database.connectionDao().upsert(connection())
        database.openHelper.writableDatabase.execSQL("DROP TABLE browse_snapshots")

        val snapshot = database.offlineSnapshotDao().read()

        assertEquals(listOf("lan"), snapshot.connections.map { it.id })
        assertTrue(snapshot.browseSnapshots.isEmpty())
    }

    @Test
    fun anOversizedLegacyThreadIsNotMigratedAndTheMigrationStillVerifies() {
        val database = open()
        val writes = listOf(
            NativeMigrationWrite.UpsertCachedThread("lan:huge", """{"items":[{"id":"a","text":"$huge"}]}"""),
            NativeMigrationWrite.UpsertCachedThread("lan:small", """{"items":[{"id":"b","text":"hi"}]}"""),
        )
        val plan = AtomicMigrationPlan("source", LocalMigrationFingerprint.fingerprint(writes), writes)

        assertEquals(MigrationExecution.MIGRATED, MigrationExecutor.execute(plan, RoomNativeMigrationStore(database)))

        val snapshot = database.offlineSnapshotDao().read()
        assertEquals(listOf("lan:small"), snapshot.cachedThreads.map { it.threadKey })
        assertEquals(listOf("b"), snapshot.feedRows.map { it.itemId })
        assertEquals(MigrationExecution.ALREADY_COMPLETE, MigrationExecutor.execute(plan, RoomNativeMigrationStore(database)))
    }

    private fun seedOversizedRowsWithoutRepair(includeNonCacheRows: Boolean = false) {
        val database = unrepaired()
        database.connectionDao().upsert(connection())
        database.cacheDao().replaceThread(
            CachedThreadEntity("lan:small", "{}"),
            listOf(
                CachedFeedRowEntity("lan:small", "small-row", 0, "{}"),
                CachedFeedRowEntity("lan:small", "huge-row", 1, huge),
            ),
        )
        database.cacheDao().upsertThread(CachedThreadEntity("lan:huge", huge))
        database.browseSnapshotDao().upsert(BrowseSnapshotEntity("small-browse", "lan", "projects", null, "[]", 1))
        database.browseSnapshotDao().upsert(BrowseSnapshotEntity("huge-browse", "lan", "workspaces", null, huge, 1))
        if (includeNonCacheRows) seedOversizedNonCacheRows(database)
        database.close()
        opened.remove(database)
    }

    /** Not caches: only the repair handles these, once they could not be read at all. */
    private fun seedOversizedNonCacheRows(database: SwitchboardDatabase) {
        database.outboxDao().insertMessage(
            OutboxEntity(
                origin = "o1", bubbleId = "b1", connectionId = "lan", threadId = "t", text = huge,
                runtimeMode = null, createdAtMs = 1, attempts = 0, nextAttemptAtMs = 1,
                deliveryState = "pending", stateReason = null, receiptLegacy = null,
                receiptDuplicate = null, receiptRawJson = null, legacyRawJson = null,
            ),
        )
        database.preferenceDao().upsertThreadPreference(ThreadPreferenceEntity("lan:small", null, null, huge, 1))
    }

    private fun connection() = ConnectionEntity("lan", "Mac", "ws", "ws://mac:8765", null, null, null, null)

    private fun open(): SwitchboardDatabase =
        SwitchboardDatabase.builder(context).allowMainThreadQueries().build().also(opened::add)

    private fun unrepaired(): SwitchboardDatabase = Room.databaseBuilder(
        context,
        SwitchboardDatabase::class.java,
        SwitchboardDatabase.DATABASE_NAME,
    ).allowMainThreadQueries().build().also(opened::add)

    private fun <T> raw(block: (SQLiteDatabase) -> T): T {
        val db = SQLiteDatabase.openDatabase(
            context.getDatabasePath(SwitchboardDatabase.DATABASE_NAME).path,
            null,
            SQLiteDatabase.OPEN_READWRITE,
        )
        return try {
            block(db)
        } finally {
            db.close()
        }
    }

    private fun rawQueryAll(sql: String) = raw { db ->
        db.rawQuery(sql, null).use { cursor -> while (cursor.moveToNext()) cursor.getString(0) }
    }

    private fun countOver(db: SQLiteDatabase, table: String): Long =
        db.rawQuery(
            "SELECT COUNT(*) FROM $table WHERE length(CAST(rawJson AS BLOB)) > ${CacheRowLimits.MAX_CACHED_ROW_BYTES}",
            null,
        ).use { cursor ->
            cursor.moveToFirst()
            cursor.getLong(0)
        }
}
