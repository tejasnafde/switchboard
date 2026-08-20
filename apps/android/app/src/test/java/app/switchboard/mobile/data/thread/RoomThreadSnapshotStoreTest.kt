package app.switchboard.mobile.data.thread

import app.switchboard.mobile.data.local.CacheDao
import app.switchboard.mobile.data.local.CachedFeedRowEntity
import app.switchboard.mobile.data.local.CachedThreadEntity
import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.domain.remote.MessageImage
import app.switchboard.mobile.domain.thread.FeedItem
import app.switchboard.mobile.domain.thread.MessagePill
import app.switchboard.mobile.domain.thread.TodoEntry
import java.util.concurrent.Executor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RoomThreadSnapshotStoreTest {
    @Test
    fun `save updates memory immediately and coalesces Room work to the latest state`() {
        val dao = FakeCacheDao()
        val writes = QueuedExecutor()
        val store = RoomThreadSnapshotStore(dao, writes)

        store.save("mac", "thread-1", thread("first"))
        store.save("mac", "thread-1", thread("latest").copy(awaitingReseed = true))

        assertEquals("latest", userText(store.get("mac", "thread-1")))
        assertEquals(false, store.get("mac", "thread-1")?.awaitingReseed)
        assertEquals(1, writes.tasks.size)
        assertNull(dao.findThread("mac:thread-1"))

        writes.runNext()

        assertEquals("latest", userText(dao.decode("mac", "thread-1")))
    }

    @Test
    fun `persisted snapshot round trips route metadata images and retained feed kinds`() {
        val dao = FakeCacheDao()
        val store = RoomThreadSnapshotStore(dao, Executor(Runnable::run))
        val expected = ThreadState(
            feed = listOf(
                FeedItem.User(
                    id = "user",
                    text = "photo",
                    at = 7,
                    images = listOf(MessageImage("file:///photo.png", "image/png", "photo.png")),
                    pillsMeta = mapOf(
                        "selection-1" to MessagePill("Admin panel", "chat-message"),
                    ),
                ),
                FeedItem.Retry("retry", "turn-1", "Retrying", active = true),
                FeedItem.Todo("todo", "todo-1", listOf(TodoEntry("Ship", "in_progress"))),
            ),
            status = "idle",
            runtimeMode = "full-access",
            provider = "codex",
            instanceId = "codex-tejas",
            instanceName = "Tejas",
            sessionId = "provider-session",
            usedTokens = 12,
            maxTokens = 100,
            costUsd = 0.25,
            resolvedModel = "gpt-5.6",
            availableVariants = listOf("high", "fast"),
            currentVariant = "high",
            lastTurnDurationMs = 90,
            unread = 2,
        )

        store.save("mac", "thread-1", expected)

        assertEquals(expected, dao.decode("mac", "thread-1"))
    }

    @Test
    fun `startup seed fills missing entries without rolling back newer memory`() {
        val dao = FakeCacheDao()
        val store = RoomThreadSnapshotStore(dao, Executor(Runnable::run))
        store.save("mac", "thread-1", thread("current"))

        store.seed(snapshot("mac", "thread-1", thread("stale")))
        store.seed(snapshot("mac", "thread-2", thread("saved")))

        assertEquals("current", userText(store.get("mac", "thread-1")))
        assertEquals("saved", userText(store.get("mac", "thread-2")))
    }

    private fun thread(text: String) = ThreadState(
        feed = listOf(FeedItem.User("user", text, 1)),
        status = "idle",
    )

    private fun snapshot(connectionId: String, threadId: String, state: ThreadState): OfflineSnapshot {
        val encoded = ThreadSnapshotCacheCodec.encode(connectionId, threadId, state)
        return offlineSnapshot(listOf(encoded.thread), encoded.feed)
    }

    private fun userText(state: ThreadState?): String? =
        (state?.feed?.singleOrNull() as? FeedItem.User)?.text

    private fun FakeCacheDao.decode(connectionId: String, threadId: String): ThreadState? =
        CachedThreadStateMapper.from(
            offlineSnapshot(allThreads(), allFeedRows()),
            connectionId,
            threadId,
        )

    private fun offlineSnapshot(
        threads: List<CachedThreadEntity>,
        feed: List<CachedFeedRowEntity>,
    ) = OfflineSnapshot(
        connections = emptyList(),
        credentialRefs = emptyList(),
        nativeCredentialRefs = emptyList(),
        preferences = emptyList(),
        threadPreferences = emptyList(),
        collapsedWorkspaces = emptyList(),
        cachedThreads = threads,
        feedRows = feed,
        outbox = emptyList(),
        outboxAttachments = emptyList(),
        replayStates = emptyList(),
        pendingControlActions = emptyList(),
        quarantinedRecords = emptyList(),
    )
}

private class QueuedExecutor : Executor {
    val tasks = ArrayDeque<Runnable>()

    override fun execute(command: Runnable) {
        tasks += command
    }

    fun runNext() {
        tasks.removeFirst().run()
    }
}

private class FakeCacheDao : CacheDao() {
    private val threads = linkedMapOf<String, CachedThreadEntity>()
    private val feed = linkedMapOf<String, MutableList<CachedFeedRowEntity>>()

    override fun upsertThread(thread: CachedThreadEntity) {
        threads[thread.threadKey] = thread
    }

    override fun insertFeedRows(rows: List<CachedFeedRowEntity>) {
        rows.forEach { row -> feed.getOrPut(row.threadKey, ::mutableListOf).add(row) }
    }

    override fun clearFeedRows(threadKey: String) {
        feed.remove(threadKey)
    }

    override fun findThread(threadKey: String): CachedThreadEntity? = threads[threadKey]

    override fun feedRows(threadKey: String): List<CachedFeedRowEntity> =
        feed[threadKey].orEmpty()

    override fun allThreads(): List<CachedThreadEntity> = threads.values.toList()

    override fun allFeedRows(): List<CachedFeedRowEntity> = feed.values.flatten()
}
