package app.switchboard.mobile.data.local

import androidx.sqlite.db.SupportSQLiteDatabase

/**
 * Drops rows too large to read back before anything queries them. Sizes are
 * measured inside SQLite (`length(CAST(x AS BLOB))`), so an oversized payload
 * never enters a CursorWindow; only a count and a maximum come back.
 *
 * Cache tables are cut at [CacheRowLimits.MAX_CACHED_ROW_BYTES] and refill from
 * the backend. Everything else is cut only once it could not be read at all.
 */
object OversizedRowRepair {
    data class Dropped(val table: String, val rows: Int, val largestBytes: Long)

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
        Target(
            table = "outbox",
            sizeExpression = bytes("text", "stateReason", "receiptRawJson", "legacyRawJson"),
            cap = CacheRowLimits.MAX_READABLE_ROW_BYTES,
            statements = listOf(
                "DELETE FROM `outbox_attachments` WHERE `origin` IN (SELECT `origin` FROM `outbox` WHERE %s)",
                "DELETE FROM `outbox` WHERE %s",
            ),
        ),
        Target(
            table = "thread_preferences",
            sizeExpression = bytes("draft"),
            cap = CacheRowLimits.MAX_READABLE_ROW_BYTES,
            statements = listOf("UPDATE `thread_preferences` SET `draft` = NULL WHERE %s"),
        ),
        Target(
            table = "pending_control_actions",
            sizeExpression = bytes("argsJson", "lastError"),
            cap = CacheRowLimits.MAX_READABLE_ROW_BYTES,
            statements = listOf("DELETE FROM `pending_control_actions` WHERE %s"),
        ),
        Target(
            table = "pending_worktree_creations",
            sizeExpression = bytes("requestJson"),
            cap = CacheRowLimits.MAX_READABLE_ROW_BYTES,
            statements = listOf("DELETE FROM `pending_worktree_creations` WHERE %s"),
        ),
        Target(
            table = "quarantined_records",
            sizeExpression = bytes("detail"),
            cap = CacheRowLimits.MAX_READABLE_ROW_BYTES,
            statements = listOf("DELETE FROM `quarantined_records` WHERE %s"),
        ),
        Target(
            table = "app_preferences",
            sizeExpression = bytes("value"),
            cap = CacheRowLimits.MAX_READABLE_ROW_BYTES,
            statements = listOf("DELETE FROM `app_preferences` WHERE %s"),
        ),
    )

    fun run(db: SupportSQLiteDatabase, log: CacheLog = AndroidCacheLog): List<Dropped> {
        val dropped = mutableListOf<Dropped>()
        db.beginTransaction()
        try {
            TARGETS.forEach { target ->
                val predicate = "${target.sizeExpression} > ${target.cap}"
                val (rows, largest) = db.query(
                    "SELECT COUNT(*), ifnull(MAX(${target.sizeExpression}), 0) FROM `${target.table}` WHERE $predicate",
                ).use { cursor ->
                    cursor.moveToFirst()
                    cursor.getInt(0) to cursor.getLong(1)
                }
                if (rows == 0) return@forEach
                target.statements.forEach { statement -> db.execSQL(statement.format(predicate)) }
                dropped += Dropped(target.table, rows, largest)
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
        dropped.forEach { drop ->
            log.warn(
                "dropped ${drop.rows} oversized row(s) from ${drop.table}, largest ${drop.largestBytes} bytes",
            )
        }
        return dropped
    }
}
