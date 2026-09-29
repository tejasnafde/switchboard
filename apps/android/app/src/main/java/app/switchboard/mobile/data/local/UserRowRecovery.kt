package app.switchboard.mobile.data.local

import androidx.sqlite.db.SupportSQLiteDatabase
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets

/**
 * Tables holding what the user wrote (queued messages, drafts, pending actions,
 * worktree requests, settings) plus migration quarantine. Unlike a cache, none of
 * their rows is ever dropped for its size. Room's queries skip a row over
 * [CacheRowLimits.MAX_READABLE_ROW_BYTES] (the `*_FITS` predicates), because one
 * such row past the CursorWindow would fail the whole query, and
 * [UserRowRecovery] reads it back instead.
 */
object UserRowTables {
    private const val CAP = CacheRowLimits.MAX_READABLE_ROW_BYTES

    private const val OUTBOX_SIZE = "(ifnull(length(CAST(text AS BLOB)), 0) + " +
        "ifnull(length(CAST(stateReason AS BLOB)), 0) + " +
        "ifnull(length(CAST(receiptRawJson AS BLOB)), 0) + " +
        "ifnull(length(CAST(legacyRawJson AS BLOB)), 0))"
    private const val THREAD_PREFERENCE_SIZE = "ifnull(length(CAST(draft AS BLOB)), 0)"
    private const val PENDING_ACTION_SIZE = "(ifnull(length(CAST(argsJson AS BLOB)), 0) + " +
        "ifnull(length(CAST(lastError AS BLOB)), 0))"
    private const val WORKTREE_REQUEST_SIZE = "ifnull(length(CAST(requestJson AS BLOB)), 0)"
    private const val APP_PREFERENCE_SIZE = "ifnull(length(CAST(value AS BLOB)), 0)"
    private const val QUARANTINE_SIZE = "ifnull(length(CAST(detail AS BLOB)), 0)"

    const val OUTBOX_FITS = "$OUTBOX_SIZE <= $CAP"
    const val THREAD_PREFERENCE_FITS = "$THREAD_PREFERENCE_SIZE <= $CAP"
    const val PENDING_ACTION_FITS = "$PENDING_ACTION_SIZE <= $CAP"
    const val WORKTREE_REQUEST_FITS = "$WORKTREE_REQUEST_SIZE <= $CAP"
    const val APP_PREFERENCE_FITS = "$APP_PREFERENCE_SIZE <= $CAP"
    const val QUARANTINE_FITS = "$QUARANTINE_SIZE <= $CAP"

    internal data class Table(
        val name: String,
        val size: String,
        val keyColumns: List<String>,
        val orderBy: String,
    ) {
        val fits: String get() = "$size <= $CAP"
    }

    internal val OUTBOX = Table("outbox", OUTBOX_SIZE, listOf("origin"), "createdAtMs, origin")
    internal val THREAD_PREFERENCES = Table("thread_preferences", THREAD_PREFERENCE_SIZE, listOf("threadKey"), "threadKey")
    internal val PENDING_ACTIONS = Table("pending_control_actions", PENDING_ACTION_SIZE, listOf("id"), "createdAt, id")
    internal val WORKTREE_CREATIONS =
        Table("pending_worktree_creations", WORKTREE_REQUEST_SIZE, listOf("creationId"), "updatedAtMs, creationId")
    internal val APP_PREFERENCES = Table("app_preferences", APP_PREFERENCE_SIZE, listOf("key"), "`key`")
    internal val QUARANTINE =
        Table("quarantined_records", QUARANTINE_SIZE, listOf("sourceKey", "code", "recordKey"), "sourceKey, recordKey, code")

    internal val ALL = listOf(OUTBOX, THREAD_PREFERENCES, PENDING_ACTIONS, WORKTREE_CREATIONS, APP_PREFERENCES, QUARANTINE)
}

/**
 * Reads rows too big for one CursorWindow a column at a time: a text column in
 * byte chunks (`substr(CAST(col AS BLOB), ...)`), decoded as UTF-8 once whole, so
 * a chunk boundary inside a character cannot corrupt it and any size comes back.
 */
class UserRowRecovery(
    private val db: SupportSQLiteDatabase,
    private val log: CacheLog = AndroidCacheLog,
) {
    internal sealed interface Recovered {
        val key: String
        val bytes: Long

        data class Row(override val key: String, override val bytes: Long, val values: StoredRow) : Recovered
        data class Unreadable(override val key: String, override val bytes: Long, val reason: String) : Recovered
    }

    internal fun scan(
        table: UserRowTables.Table,
        where: String = "1",
        args: Array<Any?> = emptyArray(),
    ): List<Recovered> {
        val keys = table.keyColumns.joinToString(", ") { "`$it`" }
        val heads = db.query(
            "SELECT rowid, ${table.size}, $keys FROM `${table.name}` " +
                "WHERE NOT (${table.fits}) AND ($where) ORDER BY ${table.orderBy}",
            args,
        ).use { cursor ->
            buildList {
                while (cursor.moveToNext()) {
                    val key = table.keyColumns.indices.joinToString("|") { cursor.getString(it + 2).orEmpty() }
                    add(Triple(cursor.getLong(0), cursor.getLong(1), key))
                }
            }
        }
        if (heads.isEmpty()) return emptyList()
        val columns = columnsOf(table.name)
        return heads.map { (rowId, bytes, key) ->
            try {
                Recovered.Row(key, bytes, StoredRow(columns.associateWith { readColumn(table.name, it, rowId) }))
            } catch (_: CharacterCodingException) {
                Recovered.Unreadable(key, bytes, "not valid UTF-8")
            } catch (error: android.database.SQLException) {
                Recovered.Unreadable(key, bytes, error.javaClass.simpleName)
            }
        }
    }

    fun outbox(where: String = "1", args: Array<Any?> = emptyArray()): List<OutboxEntity> =
        rows(UserRowTables.OUTBOX, where, args) { row ->
            OutboxEntity(
                origin = row.string("origin"),
                bubbleId = row.string("bubbleId"),
                connectionId = row.string("connectionId"),
                threadId = row.string("threadId"),
                text = row.string("text"),
                runtimeMode = row.stringOrNull("runtimeMode"),
                createdAtMs = row.long("createdAtMs"),
                attempts = row.long("attempts").toInt(),
                nextAttemptAtMs = row.long("nextAttemptAtMs"),
                deliveryState = row.string("deliveryState"),
                stateReason = row.stringOrNull("stateReason"),
                receiptLegacy = row.booleanOrNull("receiptLegacy"),
                receiptDuplicate = row.booleanOrNull("receiptDuplicate"),
                receiptRawJson = row.stringOrNull("receiptRawJson"),
                legacyRawJson = row.stringOrNull("legacyRawJson"),
                delivery = row.stringOrNull("delivery"),
            )
        }

    fun threadPreferences(where: String = "1", args: Array<Any?> = emptyArray()): List<ThreadPreferenceEntity> =
        rows(UserRowTables.THREAD_PREFERENCES, where, args) { row ->
            ThreadPreferenceEntity(
                threadKey = row.string("threadKey"),
                mode = row.stringOrNull("mode"),
                model = row.stringOrNull("model"),
                draft = row.stringOrNull("draft"),
                touchedAt = row.long("touchedAt"),
                editingOrigin = row.stringOrNull("editingOrigin"),
            )
        }

    fun pendingActions(): List<PendingControlActionEntity> = rows(UserRowTables.PENDING_ACTIONS) { row ->
        PendingControlActionEntity(
            id = row.string("id"),
            connectionId = row.string("connectionId"),
            channel = row.string("channel"),
            argsJson = row.string("argsJson"),
            requestId = row.stringOrNull("requestId"),
            idempotencyKey = row.stringOrNull("idempotencyKey"),
            createdAt = row.long("createdAt"),
            attempts = row.long("attempts").toInt(),
            status = row.string("status"),
            lastError = row.stringOrNull("lastError"),
        )
    }

    fun worktreeCreations(): List<PendingWorktreeCreationEntity> = rows(UserRowTables.WORKTREE_CREATIONS) { row ->
        PendingWorktreeCreationEntity(
            creationId = row.string("creationId"),
            connectionId = row.string("connectionId"),
            projectPath = row.string("projectPath"),
            requestJson = row.string("requestJson"),
            updatedAtMs = row.long("updatedAtMs"),
        )
    }

    fun preferences(where: String = "1", args: Array<Any?> = emptyArray()): List<AppPreferenceEntity> =
        rows(UserRowTables.APP_PREFERENCES, where, args) { row ->
            AppPreferenceEntity(key = row.string("key"), value = row.string("value"))
        }

    fun quarantine(where: String = "1", args: Array<Any?> = emptyArray()): List<QuarantinedRecordEntity> =
        rows(UserRowTables.QUARANTINE, where, args) { row ->
            QuarantinedRecordEntity(
                sourceKey = row.string("sourceKey"),
                code = row.string("code"),
                recordKey = row.string("recordKey"),
                detail = row.string("detail"),
                severity = row.string("severity"),
            )
        }

    /** Adds the rows Room's queries skipped, in each query's own order. */
    fun complete(snapshot: OfflineSnapshot): OfflineSnapshot = snapshot.copy(
        preferences = (snapshot.preferences + preferences()).sortedBy { it.key },
        threadPreferences = (snapshot.threadPreferences + threadPreferences()).sortedBy { it.threadKey },
        outbox = (snapshot.outbox + outbox()).sortedWith(compareBy({ it.createdAtMs }, { it.origin })),
        pendingControlActions = (snapshot.pendingControlActions + pendingActions())
            .sortedWith(compareBy({ it.createdAt }, { it.id })),
        quarantinedRecords = (snapshot.quarantinedRecords + quarantine())
            .sortedWith(compareBy({ it.sourceKey }, { it.recordKey }, { it.code })),
        pendingWorktreeCreations = (snapshot.pendingWorktreeCreations + worktreeCreations())
            .sortedWith(compareBy({ it.updatedAtMs }, { it.creationId })),
    )

    private fun <T> rows(
        table: UserRowTables.Table,
        where: String = "1",
        args: Array<Any?> = emptyArray(),
        map: (StoredRow) -> T,
    ): List<T> = scanOrEmpty(table, where, args).mapNotNull { recovered ->
        when (recovered) {
            is Recovered.Row -> try {
                map(recovered.values)
            } catch (error: RuntimeException) {
                log.warn("${table.name} row of ${recovered.bytes} bytes skipped: ${error.javaClass.simpleName}")
                null
            }
            is Recovered.Unreadable -> {
                log.warn("${table.name} row of ${recovered.bytes} bytes skipped: ${recovered.reason}")
                null
            }
        }
    }

    /** A read path must never fail on a table it cannot scan: it loses only those rows. */
    private fun scanOrEmpty(table: UserRowTables.Table, where: String, args: Array<Any?>): List<Recovered> = try {
        scan(table, where, args)
    } catch (error: Exception) {
        log.warn("${table.name} oversized rows skipped, scan failed: ${error.javaClass.simpleName}")
        emptyList()
    }

    private fun columnsOf(table: String): List<String> =
        db.query("PRAGMA table_info(`$table`)").use { cursor ->
            val name = cursor.getColumnIndexOrThrow("name")
            buildList { while (cursor.moveToNext()) add(cursor.getString(name)) }
        }

    private fun readColumn(table: String, column: String, rowId: Long): Any? {
        val type = db.query("SELECT typeof(`$column`) FROM `$table` WHERE rowid = ?", arrayOf(rowId))
            .use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null }
        return when (type) {
            "integer" -> db.query("SELECT `$column` FROM `$table` WHERE rowid = ?", arrayOf(rowId))
                .use { cursor -> cursor.moveToFirst(); cursor.getLong(0) }
            "real" -> db.query("SELECT `$column` FROM `$table` WHERE rowid = ?", arrayOf(rowId))
                .use { cursor -> cursor.moveToFirst(); cursor.getDouble(0) }
            "text" -> StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(readBytes(table, column, rowId)))
                .toString()
            "blob" -> readBytes(table, column, rowId)
            else -> null
        }
    }

    private fun readBytes(table: String, column: String, rowId: Long): ByteArray {
        val total = db.query("SELECT length(CAST(`$column` AS BLOB)) FROM `$table` WHERE rowid = ?", arrayOf(rowId))
            .use { cursor -> cursor.moveToFirst(); cursor.getLong(0) }
        val bytes = ByteArrayOutputStream(total.toInt())
        var offset = 1L
        while (offset <= total) {
            db.query(
                "SELECT substr(CAST(`$column` AS BLOB), ?, ?) FROM `$table` WHERE rowid = ?",
                arrayOf<Any?>(offset, CHUNK_BYTES, rowId),
            ).use { cursor ->
                cursor.moveToFirst()
                bytes.write(cursor.getBlob(0))
            }
            offset += CHUNK_BYTES
        }
        return bytes.toByteArray()
    }

    private companion object {
        const val CHUNK_BYTES = 256 * 1024
    }
}

internal class StoredRow(private val values: Map<String, Any?>) {
    fun string(column: String): String = requireNotNull(stringOrNull(column)) { "$column is missing" }

    fun stringOrNull(column: String): String? = values[column] as? String

    fun long(column: String): Long = requireNotNull(values[column] as? Long) { "$column is missing" }

    fun booleanOrNull(column: String): Boolean? = (values[column] as? Long)?.let { it != 0L }
}
