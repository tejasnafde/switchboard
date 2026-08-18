package app.switchboard.mobile.platform.migration

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteException

class AndroidLegacyDatabaseReader(
    private val context: Context,
) : LegacyDatabaseReader {
    override fun read(query: LegacyDatabaseQuery): LegacyDatabaseRead {
        val path = context.getDatabasePath(query.layout.database)
        if (!path.isFile) return LegacyDatabaseRead.Missing

        val database = try {
            SQLiteDatabase.openDatabase(path.absolutePath, null, SQLiteDatabase.OPEN_READONLY)
        } catch (error: SQLiteException) {
            return failure(error, LegacyInventoryFailure.Kind.OPEN)
        }

        return try {
            val exactKeys = query.exactKeys.sorted()
            val placeholders = exactKeys.joinToString(",") { "?" }
            val selection = "key IN ($placeholders) OR key LIKE ?"
            val arguments = (exactKeys + query.likePattern).toTypedArray()
            val rows = linkedMapOf<String, String>()
            database.query(
                query.layout.table,
                arrayOf("key", "value"),
                selection,
                arguments,
                null,
                null,
                "key ASC",
            ).use { cursor ->
                val keyColumn = cursor.getColumnIndexOrThrow("key")
                val valueColumn = cursor.getColumnIndexOrThrow("value")
                while (cursor.moveToNext()) {
                    rows[cursor.getString(keyColumn)] = cursor.getString(valueColumn)
                }
            }
            LegacyDatabaseRead.Rows(rows)
        } catch (error: SQLiteException) {
            failure(error, LegacyInventoryFailure.Kind.READ)
        } catch (error: IllegalArgumentException) {
            LegacyDatabaseRead.Failure(
                LegacyInventoryFailure.Kind.SCHEMA,
                error.message ?: "legacy database schema is incompatible",
            )
        } finally {
            database.close()
        }
    }

    private fun failure(
        error: SQLiteException,
        fallback: LegacyInventoryFailure.Kind,
    ): LegacyDatabaseRead.Failure {
        val detail = error.message ?: error.javaClass.simpleName
        val normalized = detail.lowercase()
        val kind = when {
            normalized.contains("wal") || normalized.contains("checkpoint") -> LegacyInventoryFailure.Kind.WAL
            normalized.contains("no such table") ||
                normalized.contains("no such column") ||
                normalized.contains("malformed") -> LegacyInventoryFailure.Kind.SCHEMA
            else -> fallback
        }
        return LegacyDatabaseRead.Failure(kind, detail)
    }
}
