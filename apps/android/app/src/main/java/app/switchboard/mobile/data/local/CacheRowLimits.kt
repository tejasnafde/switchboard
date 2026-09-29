package app.switchboard.mobile.data.local

import android.util.Log

/**
 * Android reads a query through a CursorWindow of about 2 MB, and one row larger
 * than that fails the WHOLE query with SQLiteBlobTooBigException ("Row too big
 * to fit into CursorWindow"). The offline snapshot reads every cache table in one
 * go, so a single big file-edit feed row blocked startup and the machines list.
 */
object CacheRowLimits {
    /** Largest cache payload written or read back. Caches refill from the backend. */
    const val MAX_CACHED_ROW_BYTES = 512 * 1024

    /**
     * Rows that are not caches (queued turns, drafts) are only dropped once they
     * could no longer be read at all, well under the 2 MB window.
     */
    const val MAX_READABLE_ROW_BYTES = 1536 * 1024

    /** UTF-8 size, which is what SQLite stores and the CursorWindow copies. */
    fun utf8Bytes(value: String): Long {
        var bytes = 0L
        var index = 0
        while (index < value.length) {
            val char = value[index]
            bytes += when {
                char.code < 0x80 -> 1
                char.code < 0x800 -> 2
                Character.isHighSurrogate(char) && index + 1 < value.length &&
                    Character.isLowSurrogate(value[index + 1]) -> {
                    index++
                    4
                }
                else -> 3
            }
            index++
        }
        return bytes
    }

    fun fitsCache(value: String): Boolean = utf8Bytes(value) <= MAX_CACHED_ROW_BYTES
}

/** Row sizes and counts only, never row content. */
fun interface CacheLog {
    fun warn(message: String)
}

object AndroidCacheLog : CacheLog {
    private const val TAG = "SwitchboardCache"

    override fun warn(message: String) {
        Log.w(TAG, message)
    }
}
