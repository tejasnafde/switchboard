package app.switchboard.mobile.data.thread

import app.switchboard.mobile.data.local.CachedFeedRowEntity
import app.switchboard.mobile.data.local.CachedThreadEntity
import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.domain.thread.FeedItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CachedThreadStateMapperTest {
    @Test
    fun `restores the exact thread metadata and ordered visible feed`() {
        val snapshot = snapshot(
            thread = CachedThreadEntity(
                "mac:thread-1",
                """{"status":"idle","runtimeMode":"plan","provider":"codex","unread":2}""",
            ),
            rows = listOf(
                CachedFeedRowEntity(
                    "mac:thread-1",
                    "u1",
                    0,
                    """{"kind":"user","id":"u1","text":"[[pill:selection-1]] hello","at":7,"images":["data:image/png;base64,AAAA"],"pillsMeta":{"selection-1":{"label":"Admin panel","kind":"chat-message"},"bad":{"label":"Bad","kind":"other"}}}""",
                ),
                CachedFeedRowEntity(
                    "mac:thread-1",
                    "a1",
                    1,
                    """{"kind":"text","id":"a1","text":"hi","stream":"assistant","done":true,"durationMs":40}""",
                ),
            ),
        )

        val restored = CachedThreadStateMapper.from(snapshot, "mac", "thread-1")!!

        assertEquals("idle", restored.status)
        assertEquals("plan", restored.runtimeMode)
        assertEquals("codex", restored.provider)
        assertEquals(2, restored.unread)
        assertEquals(listOf("u1", "a1"), restored.feed.map(FeedItem::id))
        val user = restored.feed.first() as FeedItem.User
        assertEquals(7, user.at)
        assertEquals("data:image/png;base64,AAAA", user.images.single().url)
        assertEquals("Admin panel", user.pillsMeta["selection-1"]?.label)
        assertEquals(setOf("selection-1"), user.pillsMeta.keys)
        val assistant = restored.feed.last() as FeedItem.Text
        assertTrue(assistant.done)
        assertEquals(40L, assistant.durationMs)
    }

    @Test
    fun `never returns another machine thread and ignores corrupt feed rows`() {
        val snapshot = snapshot(
            thread = CachedThreadEntity("mac:thread-1", "{}"),
            rows = listOf(
                CachedFeedRowEntity("mac:thread-1", "broken", 0, "not-json"),
            ),
        )

        assertTrue(CachedThreadStateMapper.from(snapshot, "mac", "thread-1")!!.feed.isEmpty())
        assertNull(CachedThreadStateMapper.from(snapshot, "other", "thread-1"))
    }

    @Test
    fun `restores every retained React Native feed kind without dropping rows`() {
        val rows = listOf(
            """{"kind":"tool","id":"tool","toolName":"Bash","input":{"command":"npm test"},"output":"ok","state":"done"}""",
            """{"kind":"denial","id":"denial","toolName":"Write","reason":"Plan mode"}""",
            """{"kind":"approval","id":"approval","requestId":"request-1","toolName":"Bash","detail":"npm test","requestType":"tool","state":"pending"}""",
            """{"kind":"question","id":"question","requestId":"request-2","questions":[{"id":"choice","header":"Choose","question":"Which?","options":[{"label":"A","description":"First"}],"multiSelect":false}],"answers":[["A"]]}""",
            """{"kind":"plan","id":"plan","planId":"plan-1","markdown":"# Plan"}""",
            """{"kind":"fileEdit","id":"file","relPath":"src/Main.kt","changeKind":"modify","oldContent":"old","newContent":"new"}""",
        ).mapIndexed { index, raw ->
            CachedFeedRowEntity("mac:thread-1", "row-$index", index, raw)
        }
        val restored = CachedThreadStateMapper.from(
            snapshot(CachedThreadEntity("mac:thread-1", "{}"), rows),
            "mac",
            "thread-1",
        )!!

        assertEquals(6, restored.feed.size)
        assertEquals("npm test", ((restored.feed[0] as FeedItem.Tool).input as app.switchboard.mobile.protocol.JsonObject)
            .values["command"]?.let { (it as app.switchboard.mobile.protocol.JsonString).value })
        assertEquals("Plan mode", (restored.feed[1] as FeedItem.Denial).reason)
        assertEquals("request-1", (restored.feed[2] as FeedItem.Approval).requestId)
        assertEquals(listOf(listOf("A")), (restored.feed[3] as FeedItem.Question).answers)
        assertEquals("# Plan", (restored.feed[4] as FeedItem.Plan).markdown)
        assertEquals("src/Main.kt", (restored.feed[5] as FeedItem.FileEdit).relPath)
    }

    private fun snapshot(
        thread: CachedThreadEntity,
        rows: List<CachedFeedRowEntity>,
    ) = OfflineSnapshot(
        connections = emptyList(),
        credentialRefs = emptyList(),
        nativeCredentialRefs = emptyList(),
        preferences = emptyList(),
        threadPreferences = emptyList(),
        collapsedWorkspaces = emptyList(),
        cachedThreads = listOf(thread),
        feedRows = rows,
        outbox = emptyList(),
        outboxAttachments = emptyList(),
        replayStates = emptyList(),
        pendingControlActions = emptyList(),
        quarantinedRecords = emptyList(),
    )
}
