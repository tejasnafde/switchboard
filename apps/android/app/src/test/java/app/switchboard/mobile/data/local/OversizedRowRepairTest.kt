package app.switchboard.mobile.data.local

import android.app.Application
import android.content.Context
import android.database.sqlite.SQLiteBlobTooBigException
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteException
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import app.switchboard.mobile.data.AtomicMigrationPlan
import app.switchboard.mobile.data.MigrationExecution
import app.switchboard.mobile.data.MigrationExecutor
import app.switchboard.mobile.data.NativeMigrationWrite
import app.switchboard.mobile.data.composer.ComposerDraftLoadResult
import app.switchboard.mobile.data.composer.RoomComposerDraftStore
import app.switchboard.mobile.data.outbox.OutboxLoadResult
import app.switchboard.mobile.data.outbox.RoomOutboxStore
import app.switchboard.mobile.data.thread.RoomThreadSnapshotStore
import app.switchboard.mobile.data.thread.ThreadState
import app.switchboard.mobile.domain.thread.FeedItem
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
// A plain Application: SwitchboardApplication.onCreate starts the native runtime,
// whose startup migration opens this same database file in the background and
// can overwrite the checkpoint between the two execute() calls below.
@Config(sdk = [35], application = Application::class)
class OversizedRowRepairTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val huge = "x".repeat(3 * 1024 * 1024)

    /** Over the readable cap but inside a 2 MB CursorWindow: the case a delete would lose. */
    private val queuedText = "q".repeat(1600 * 1024)

    /** Far past the CursorWindow, with multi-byte characters across chunk boundaries. */
    private val draftText = "dé€😀".repeat(3 * 1024 * 1024 / 10)
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
        seedOversizedRowsWithoutRepair(includeUserRows = true)
        assertThrows(SQLiteBlobTooBigException::class.java) {
            rawQueryAll("SELECT * FROM cached_feed_rows")
        }

        val warnings = mutableListOf<String>()
        val repairing = unrepaired()
        val report = OversizedRowRepair.run(repairing.openHelper.writableDatabase, warnings::add)
        repairing.close()
        opened.remove(repairing)

        assertEquals(
            listOf(
                OversizedRowRepair.Dropped("cached_threads", 1, huge.length.toLong()),
                OversizedRowRepair.Dropped("cached_feed_rows", 1, huge.length.toLong()),
                OversizedRowRepair.Dropped("browse_snapshots", 1, huge.length.toLong()),
            ),
            report.dropped,
        )
        assertEquals(mapOf("outbox" to 1, "thread_preferences" to 1), report.recovered)
        assertTrue(report.quarantined.isEmpty())
        assertTrue(warnings.none { "xxxx" in it || "qqqq" in it || "dddd" in it })
        assertEquals(5, warnings.size)

        val snapshot = open().readOfflineSnapshot()
        assertEquals(listOf("lan"), snapshot.connections.map { it.id })
        assertEquals(listOf("lan:small"), snapshot.cachedThreads.map { it.threadKey })
        assertEquals(listOf("small-row"), snapshot.feedRows.map { it.itemId })
        assertEquals(listOf("small-browse"), snapshot.browseSnapshots.map { it.snapshotKey })
        assertEquals(listOf("hi", queuedText), snapshot.outbox.map { it.text })
        assertEquals(listOf(draftText, "short"), snapshot.threadPreferences.map { it.draft })
    }

    @Test
    fun aLargeQueuedMessageAndDraftSurviveTheRepairAndLoadThroughTheirStores() {
        seedOversizedRowsWithoutRepair(includeUserRows = true)
        val database = open()

        val outbox = RoomOutboxStore(database.outboxDao(), database::recoveredOutbox).load() as OutboxLoadResult.Success
        val drafts = RoomComposerDraftStore(database.composerDraftDao(), database::recoveredDrafts).load()
            as ComposerDraftLoadResult.Success

        assertEquals(listOf("small-queued", "o1"), outbox.turns.map { it.origin })
        assertEquals(queuedText, outbox.turns.last().text)
        assertEquals(listOf("lan:big", "lan:small"), drafts.drafts.map { it.key.storageKey })
        assertEquals(draftText, drafts.drafts.first().text)
        assertEquals(1L, raw { db -> count(db, "SELECT COUNT(*) FROM outbox WHERE origin = 'o1'") })
    }

    @Test
    fun aUserRowThatCannotBeRecoveredIsQuarantinedAndKeptNotDeleted() {
        val database = open()
        database.connectionDao().upsert(connection())
        database.outboxDao().insertMessage(outbox("bad", text = "placeholder", createdAtMs = 1))
        val invalidUtf8 = ByteArray(CacheRowLimits.MAX_READABLE_ROW_BYTES + 1) { 0xFF.toByte() }
        database.openHelper.writableDatabase.execSQL(
            "UPDATE outbox SET text = CAST(? AS TEXT) WHERE origin = 'bad'",
            arrayOf(invalidUtf8),
        )

        val warnings = mutableListOf<String>()
        val report = OversizedRowRepair.run(database.openHelper.writableDatabase, warnings::add)

        assertEquals(listOf("outbox:bad"), report.quarantined)
        assertEquals(1L, raw { db -> count(db, "SELECT COUNT(*) FROM outbox WHERE origin = 'bad'") })
        val snapshot = database.readOfflineSnapshot()
        assertTrue(snapshot.outbox.isEmpty())
        val record = snapshot.quarantinedRecords.single()
        assertEquals(OversizedRowRepair.QUARANTINE_SOURCE, record.sourceKey)
        assertEquals("outbox:bad", record.recordKey)
        assertTrue(record.detail, record.detail.startsWith("${invalidUtf8.size} bytes, not valid UTF-8"))
        assertEquals(listOf("outbox row of ${invalidUtf8.size} bytes quarantined: not valid UTF-8"), warnings)
    }

    @Test
    fun aUserTableScanThatThrowsCannotUndoTheCacheRepairOrBlockStartup() {
        seedOversizedRowsWithoutRepair(includeUserRows = true)
        val database = unrepaired()
        val db = database.openHelper.writableDatabase
        val real = UserRowRecovery(db) {}
        val warnings = mutableListOf<String>()

        val report = OversizedRowRepair.run(db, warnings::add) { table ->
            when (table) {
                UserRowTables.OUTBOX -> throw IllegalArgumentException("column 'name' does not exist")
                UserRowTables.THREAD_PREFERENCES -> throw SQLiteException("head query failed")
                else -> real.scan(table)
            }
        }

        assertEquals(listOf("cached_threads", "cached_feed_rows", "browse_snapshots"), report.dropped.map { it.table })
        assertTrue(report.recovered.isEmpty())
        assertTrue(warnings.contains("outbox oversized row scan failed: IllegalArgumentException"))
        assertTrue(warnings.contains("thread_preferences oversized row scan failed: SQLiteException"))
        assertTrue(warnings.none { "xxxx" in it || "qqqq" in it || "dddd" in it })
        assertEquals(0L, raw { file -> countOver(file, "cached_feed_rows") })
        rawQueryAll("SELECT * FROM cached_feed_rows")
        rawQueryAll("SELECT * FROM cached_threads")
        assertEquals(2L, raw { file -> count(file, "SELECT COUNT(*) FROM outbox") })

        val runtime = StartupRuntime.direct(
            migration = StartupMigrationRunner { StartupMigrationState.AlreadyComplete() },
            snapshot = OfflineSnapshotReader(database::readOfflineSnapshot),
            dialGate = StartupDialGate {},
        )
        runtime.start()
        val machines = StartupConnectionsMapper.map(runtime.state) as ConnectionsLoadState.Ready
        assertEquals(listOf("lan"), machines.connections.map { it.id })
    }

    @Test
    fun aTableWhoseRealHeadQueryFailsIsSkippedAndTheOtherTablesStillRecover() {
        seedOversizedRowsWithoutRepair(includeUserRows = true)
        val database = unrepaired()
        val db = database.openHelper.writableDatabase
        db.execSQL("DROP TABLE pending_worktree_creations")
        val warnings = mutableListOf<String>()

        val report = OversizedRowRepair.run(db, warnings::add)

        assertEquals(3, report.dropped.size)
        assertEquals(mapOf("outbox" to 1, "thread_preferences" to 1), report.recovered)
        assertTrue(warnings.contains("pending_worktree_creations oversized row scan failed: SQLiteException"))
        assertEquals(0L, raw { file -> countOver(file, "cached_threads") })

        val readWarnings = mutableListOf<String>()
        assertTrue(UserRowRecovery(db, readWarnings::add).worktreeCreations().isEmpty())
        assertEquals(
            listOf("pending_worktree_creations oversized rows skipped, scan failed: SQLiteException"),
            readWarnings,
        )
    }

    @Test
    fun oversizedThreadMetadataDeletesTheStaleRoomSnapshotAndItsFeed() {
        val database = open()
        val store = RoomThreadSnapshotStore(database.cacheDao(), Runnable::run) {}
        store.save("lan", "t", ThreadState(feed = listOf(FeedItem.User("u", "old", 1)), status = "idle"))
        assertEquals(1, database.cacheDao().feedRows("lan:t").size)

        store.save(
            "lan",
            "t",
            ThreadState(status = "running", availableVariants = listOf("v".repeat(CacheRowLimits.MAX_CACHED_ROW_BYTES))),
        )

        assertNull(database.cacheDao().findThread("lan:t"))
        assertTrue(database.cacheDao().feedRows("lan:t").isEmpty())
        assertEquals(0L, raw { db -> count(db, "SELECT COUNT(*) FROM cached_threads") })
    }

    @Test
    fun theProductionOpenRunsTheRepairBeforeTheFirstRead() {
        seedOversizedRowsWithoutRepair()

        val runtime = StartupRuntime.direct(
            migration = StartupMigrationRunner { StartupMigrationState.AlreadyComplete() },
            snapshot = OfflineSnapshotReader(open()::readOfflineSnapshot),
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

    private fun seedOversizedRowsWithoutRepair(includeUserRows: Boolean = false) {
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
        if (includeUserRows) seedLargeUserRows(database)
        database.close()
        opened.remove(database)
    }

    /** What the user wrote: kept whatever its size, next to an ordinary row of each. */
    private fun seedLargeUserRows(database: SwitchboardDatabase) {
        database.outboxDao().insertMessage(outbox("small-queued", text = "hi", createdAtMs = 1))
        database.outboxDao().insertMessage(outbox("o1", text = queuedText, createdAtMs = 2))
        database.preferenceDao().upsertThreadPreference(ThreadPreferenceEntity("lan:small", null, null, "short", 1))
        database.preferenceDao().upsertThreadPreference(ThreadPreferenceEntity("lan:big", null, null, draftText, 2))
    }

    private fun outbox(origin: String, text: String, createdAtMs: Long) = OutboxEntity(
        origin = origin, bubbleId = "b-$origin", connectionId = "lan", threadId = "t", text = text,
        runtimeMode = null, createdAtMs = createdAtMs, attempts = 0, nextAttemptAtMs = createdAtMs,
        deliveryState = "pending", stateReason = null, receiptLegacy = null,
        receiptDuplicate = null, receiptRawJson = null, legacyRawJson = null,
    )

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

    private fun count(db: SQLiteDatabase, sql: String): Long =
        db.rawQuery(sql, null).use { cursor ->
            cursor.moveToFirst()
            cursor.getLong(0)
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
