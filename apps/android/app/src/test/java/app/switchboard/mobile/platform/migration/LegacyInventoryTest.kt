package app.switchboard.mobile.platform.migration

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class LegacyInventoryTest {
    @Test
    fun readsBothKnownLayoutsWithOnlyExactStateKeysAndOutboxPrefix() {
        val reader = RecordingDatabaseReader(
            mapOf(
                "RKStorage" to LegacyDatabaseRead.Rows(mapOf("sb-connections" to "connections")),
                "AsyncStorage" to LegacyDatabaseRead.Rows(mapOf("sb-outbox:m1" to "message")),
            ),
        )

        val result = LegacyInventory(reader).read()

        assertEquals(
            listOf(
                LegacyDatabaseLayout("RKStorage", "catalystLocalStorage"),
                LegacyDatabaseLayout("AsyncStorage", "Storage"),
            ),
            reader.requests.map { it.layout },
        )
        assertTrue(reader.requests.all { it.exactKeys == setOf("sb-connections", "switchboard-prefs", "sb-chat-cache") })
        assertTrue(reader.requests.all { it.likePattern == "sb-outbox:%" })
        assertEquals(
            linkedMapOf("sb-connections" to "connections", "sb-outbox:m1" to "message"),
            (result as LegacyInventoryResult.Success).rows,
        )
    }

    @Test
    fun identicalRowsInBothDatabasesAreAcceptedButConflictingBytesBlockMigration() {
        val same = LegacyInventory(
            RecordingDatabaseReader(
                mapOf(
                    "RKStorage" to LegacyDatabaseRead.Rows(mapOf("sb-connections" to "same")),
                    "AsyncStorage" to LegacyDatabaseRead.Rows(mapOf("sb-connections" to "same")),
                ),
            ),
        ).read()
        assertTrue(same is LegacyInventoryResult.Success)

        val conflict = LegacyInventory(
            RecordingDatabaseReader(
                mapOf(
                    "RKStorage" to LegacyDatabaseRead.Rows(mapOf("sb-connections" to "old")),
                    "AsyncStorage" to LegacyDatabaseRead.Rows(mapOf("sb-connections" to "new")),
                ),
            ),
        ).read()
        assertTrue(conflict is LegacyInventoryResult.Failed)
        assertEquals(LegacyInventoryFailure.Kind.CONFLICT, (conflict as LegacyInventoryResult.Failed).failures.single().kind)
    }

    @Test
    fun openSchemaAndWalFailuresRemainDistinctAndPartialRowsAreNotTreatedAsSuccess() {
        for (kind in listOf(
            LegacyInventoryFailure.Kind.OPEN,
            LegacyInventoryFailure.Kind.SCHEMA,
            LegacyInventoryFailure.Kind.WAL,
        )) {
            val result = LegacyInventory(
                RecordingDatabaseReader(
                    mapOf(
                        "RKStorage" to LegacyDatabaseRead.Rows(mapOf("sb-connections" to "available")),
                        "AsyncStorage" to LegacyDatabaseRead.Failure(kind, "fixture failure"),
                    ),
                ),
            ).read()

            assertTrue(result is LegacyInventoryResult.Failed)
            result as LegacyInventoryResult.Failed
            assertEquals(kind, result.failures.single().kind)
            assertEquals(mapOf("sb-connections" to "available"), result.partialRows)
        }
    }

    private class RecordingDatabaseReader(
        private val results: Map<String, LegacyDatabaseRead>,
    ) : LegacyDatabaseReader {
        val requests = mutableListOf<LegacyDatabaseQuery>()

        override fun read(query: LegacyDatabaseQuery): LegacyDatabaseRead {
            requests += query
            return results[query.layout.database] ?: LegacyDatabaseRead.Missing
        }
    }
}
