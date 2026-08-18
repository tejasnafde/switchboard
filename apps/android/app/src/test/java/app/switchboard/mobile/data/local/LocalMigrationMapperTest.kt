package app.switchboard.mobile.data.local

import app.switchboard.mobile.compat.LegacyConnection
import app.switchboard.mobile.compat.LegacyStateDecoder
import app.switchboard.mobile.data.MigrationDecision
import app.switchboard.mobile.data.MigrationPlanner
import app.switchboard.mobile.data.NativeMigrationWrite
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LocalMigrationMapperTest {
    @Test
    fun connectionRowsPreserveTopologyButNeverInlineCredentials() {
        val source = LegacyConnection.Ws(
            id = "lan-main",
            label = "Studio Mac",
            url = "ws://mac.local:4010",
            inlineToken = "shared-secret",
            inlineSession = "device-session",
            inlinePairing = "pair-once",
        )

        val row = LocalMigrationMapper.connection(
            NativeMigrationWrite.UpsertConnection(source.id, source),
        )

        assertEquals("lan-main", row.id)
        assertEquals("ws", row.kind)
        assertEquals("ws://mac.local:4010", row.url)
        assertNull(row.project)
        assertFalse(row.toString().contains("shared-secret"))
        assertFalse(row.toString().contains("device-session"))
        assertFalse(row.toString().contains("pair-once"))
    }

    @Test
    fun cachedThreadMappingRetainsTheWholeThreadAndEachFeedItemRaw() {
        val raw =
            """{"items":[{"kind":"user","id":"u1","text":"hello"},{"kind":"text","id":"a1","text":"hi"}],"provider":"codex"}"""

        val mapped = LocalMigrationMapper.cachedThread(
            NativeMigrationWrite.UpsertCachedThread("lan-main:thread-1", raw),
        )

        assertEquals(raw, mapped.thread.rawJson)
        assertEquals(listOf("u1", "a1"), mapped.feed.map { it.itemId })
        assertEquals(listOf(0, 1), mapped.feed.map { it.position })
        assertEquals("""{"kind":"user", "id":"u1", "text":"hello"}""".withoutSpaces(), mapped.feed[0].rawJson.withoutSpaces())
    }

    @Test
    fun legacyOutboxRetainsRawPayloadWithoutTreatingDataUrisAsPrivatePaths() {
        val raw =
            """{"connectionId":"lan-main","threadId":"t1","messageId":"m1","text":"","images":[{"url":"data:image/png;base64,AAAA","mimeType":"image/png"}],"createdAt":7,"attempts":2}"""

        val mapped = LocalMigrationMapper.outbox(NativeMigrationWrite.UpsertOutbox("m1", raw))

        assertEquals("lan-main", mapped.message.connectionId)
        assertEquals("t1", mapped.message.threadId)
        assertEquals(2, mapped.message.attempts)
        assertEquals("m1", mapped.message.origin)
        assertEquals("remote_m1", mapped.message.bubbleId)
        assertEquals(7, mapped.message.nextAttemptAtMs)
        assertEquals("pending", mapped.message.deliveryState)
        assertEquals(raw, mapped.message.legacyRawJson)
        assertTrue(mapped.attachments.isEmpty())
    }

    @Test
    fun localFingerprintMatchesPlannerCanonicalFingerprint() {
        val report = LegacyStateDecoder.decode(
            mapOf(
                "sb-connections" to
                    """{"state":{"configs":[{"id":"lan","label":"Mac","kind":"ws","url":"ws://mac","token":"inline"}]},"version":0}""",
                "switchboard-prefs" to
                    """{"state":{"threads":{"lan:t":{"mode":"plan","draft":"later","at":9}},"defaultMode":"sandbox","collapsedWorkspaces":["ops"]},"version":0}""",
            ),
        )
        val plan = (MigrationPlanner.plan(report) as MigrationDecision.Ready).plan

        assertEquals(plan.nativeFingerprint, LocalMigrationFingerprint.fingerprint(plan.writes))
    }

    private fun String.withoutSpaces() = replace(" ", "")
}
