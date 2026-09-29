package app.switchboard.mobile.data.local

import androidx.sqlite.db.SupportSQLiteDatabase
import app.switchboard.mobile.compat.LegacyIssueSeverity

/**
 * Runs before anything queries the database. Sizes are measured inside SQLite
 * (`length(CAST(x AS BLOB))`), so an oversized payload never enters a
 * CursorWindow; only a count and a maximum come back.
 *
 * Only caches are dropped: rows over [CacheRowLimits.MAX_CACHED_ROW_BYTES] refill
 * from the backend. What the user wrote is never deleted for its size. An
 * oversized user row is read back in chunks to prove it recovers, and one that
 * does not is recorded in quarantine and left in place, skipped by every read.
 */
object OversizedRowRepair {
    data class Dropped(val table: String, val rows: Int, val largestBytes: Long)

    data class Report(
        val dropped: List<Dropped>,
        /** Oversized user rows kept and recovered in chunks, as `table` to count. */
        val recovered: Map<String, Int>,
        /** Oversized user rows that could not be recovered, as `table:key`. */
        val quarantined: List<String>,
    )

    internal const val QUARANTINE_SOURCE = "native-oversized-row"
    internal const val QUARANTINE_CODE = "oversized_row_unreadable"

    private data class Target(
        val table: String,
        val sizeExpression: String,
        val cap: Int,
        /** Statements run with `%s` replaced by the oversized-row predicate. */
        val statements: List<String>,
    )

    private fun bytes(vararg columns: String): String =
        columns.joinToString(" + ") { "ifnull(length(CAST(`$it` AS BLOB)), 0)" }

    private val TARGETS = listOf(
        Target(
            table = "cached_threads",
            sizeExpression = bytes("rawJson"),
            cap = CacheRowLimits.MAX_CACHED_ROW_BYTES,
            statements = listOf(
                "DELETE FROM `cached_feed_rows` WHERE `threadKey` IN (SELECT `threadKey` FROM `cached_threads` WHERE %s)",
                "DELETE FROM `cached_threads` WHERE %s",
            ),
        ),
        Target(
            table = "cached_feed_rows",
            sizeExpression = bytes("rawJson"),
            cap = CacheRowLimits.MAX_CACHED_ROW_BYTES,
            statements = listOf("DELETE FROM `cached_feed_rows` WHERE %s"),
        ),
        Target(
            table = "browse_snapshots",
            sizeExpression = bytes("rawJson"),
            cap = CacheRowLimits.MAX_CACHED_ROW_BYTES,
            statements = listOf("DELETE FROM `browse_snapshots` WHERE %s"),
        ),
    )

    /**
     * The cache deletes commit first, on their own: they are what unblocks
     * startup, so nothing after them can roll them back. Each user table is then
     * scanned in its own transaction, and a table whose scan fails is logged and
     * skipped without touching the others.
     */
    fun run(db: SupportSQLiteDatabase, log: CacheLog = AndroidCacheLog): Report =
        run(db, log, UserRowRecovery(db, log)::scan)

    internal fun run(
        db: SupportSQLiteDatabase,
        log: CacheLog,
        scan: (UserRowTables.Table) -> List<UserRowRecovery.Recovered>,
    ): Report {
        val dropped = dropOversizedCaches(db)
        dropped.forEach { drop ->
            log.warn(
                "dropped ${drop.rows} oversized row(s) from ${drop.table}, largest ${drop.largestBytes} bytes",
            )
        }
        val recovered = linkedMapOf<String, Int>()
        val quarantined = mutableListOf<String>()
        UserRowTables.ALL.forEach { table ->
            try {
                val rows = inTransaction(db) {
                    scan(table).onEach { row ->
                        if (row is UserRowRecovery.Recovered.Unreadable && table != UserRowTables.QUARANTINE) {
                            quarantine(db, table, row)
                        }
                    }
                }
                val kept = rows.count { it is UserRowRecovery.Recovered.Row }
                if (kept > 0) recovered[table.name] = kept
                rows.filterIsInstance<UserRowRecovery.Recovered.Unreadable>().forEach { row ->
                    quarantined += "${table.name}:${row.key}"
                    log.warn("${table.name} row of ${row.bytes} bytes quarantined: ${row.reason}")
                }
            } catch (error: Exception) {
                log.warn("${table.name} oversized row scan failed: ${error.javaClass.simpleName}")
            }
        }
        recovered.forEach { (table, rows) ->
            log.warn("kept $rows oversized row(s) in $table, read back in chunks")
        }
        return Report(dropped, recovered, quarantined)
    }

    private fun dropOversizedCaches(db: SupportSQLiteDatabase): List<Dropped> = inTransaction(db) {
        TARGETS.mapNotNull { target ->
            val predicate = "${target.sizeExpression} > ${target.cap}"
            val (rows, largest) = db.query(
                "SELECT COUNT(*), ifnull(MAX(${target.sizeExpression}), 0) FROM `${target.table}` WHERE $predicate",
            ).use { cursor ->
                cursor.moveToFirst()
                cursor.getInt(0) to cursor.getLong(1)
            }
            if (rows == 0) return@mapNotNull null
            target.statements.forEach { statement -> db.execSQL(statement.format(predicate)) }
            Dropped(target.table, rows, largest)
        }
    }

    private fun <T> inTransaction(db: SupportSQLiteDatabase, block: () -> T): T {
        db.beginTransaction()
        try {
            return block().also { db.setTransactionSuccessful() }
        } finally {
            db.endTransaction()
        }
    }

    private fun quarantine(
        db: SupportSQLiteDatabase,
        table: UserRowTables.Table,
        row: UserRowRecovery.Recovered.Unreadable,
    ) {
        db.execSQL(
            "INSERT OR REPLACE INTO quarantined_records (sourceKey, code, recordKey, detail, severity) " +
                "VALUES (?, ?, ?, ?, ?)",
            arrayOf(
                QUARANTINE_SOURCE,
                QUARANTINE_CODE,
                "${table.name}:${row.key}",
                "${row.bytes} bytes, ${row.reason}; kept in ${table.name}, skipped by reads",
                LegacyIssueSeverity.QUARANTINED.name,
            ),
        )
    }
}
