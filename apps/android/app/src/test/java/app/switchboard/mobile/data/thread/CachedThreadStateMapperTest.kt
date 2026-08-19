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
                    """{"kind":"user","id":"u1","text":"hello","at":7,"images":["data:image/png;base64,AAAA"]}""",
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
