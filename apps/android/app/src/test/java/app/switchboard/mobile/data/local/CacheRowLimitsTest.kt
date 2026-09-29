package app.switchboard.mobile.data.local

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CacheRowLimitsTest {
    @Test
    fun countsUtf8BytesTheWaySqliteStoresThem() {
        listOf("", "abc", "é", "€", "😀", "a😀é€").forEach { value ->
            assertEquals(value, value.toByteArray(Charsets.UTF_8).size.toLong(), CacheRowLimits.utf8Bytes(value))
        }
    }

    @Test
    fun theCacheCapIsInclusiveAndCountsBytesNotChars() {
        assertTrue(CacheRowLimits.fitsCache("x".repeat(CacheRowLimits.MAX_CACHED_ROW_BYTES)))
        assertFalse(CacheRowLimits.fitsCache("x".repeat(CacheRowLimits.MAX_CACHED_ROW_BYTES + 1)))
        assertFalse(CacheRowLimits.fitsCache("é".repeat(CacheRowLimits.MAX_CACHED_ROW_BYTES / 2 + 1)))
    }
}
