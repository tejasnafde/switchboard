package app.switchboard.mobile.data.thread

import app.switchboard.mobile.data.local.CachedThreadWithFeed
import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.domain.remote.ChatMessage
import app.switchboard.mobile.domain.remote.LoadedSession
import app.switchboard.mobile.domain.thread.FeedItem
import app.switchboard.mobile.domain.thread.ThreadEventDecoder
import app.switchboard.mobile.domain.thread.ThreadEventScope
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.ui.thread.ThreadPresenter
import app.switchboard.mobile.ui.thread.ThreadRowPresentation
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The notices from the 2026-09-29 phone screenshots, verbatim, rendered raw as
 * user bubbles by an APK built before the synthetic split existed. Every path
 * that fills the feed must turn them into compact rows.
 */
class TaskNotificationRowsTest {
    private val outputFile = "/private/tmp/claude-501/-Users-tejas-Library-Application-Support-switchboard-worktrees-" +
        "geoiq-lk-ssg-bot-v2-7b77f6fbb7-thread-442c0cd8-bfab-48cd-81cd-abce5144c9e9-c27284111e/" +
        "4858f116-7ed1-4a57-8921-0b26aa79ccb9/tasks/busj5onh3.output"
    private val withOutputFile = "<task-notification>\n<task-id>busj5onh3</task-id>\n<output-file>$outputFile</output-file>\n" +
        "<status>completed</status>\n<summary>Background command \"Wait for all VM eval runs to finish\" completed (exit code 0)</summary>\n" +
        "</task-notification>"
    private val withoutOutputFile = "<task-notification>\n<task-id>bcy3ng5gb</task-id>\n<status>completed</status>\n" +
        "<summary>Remove VM worktree, drop temp World DB, clean temp files</summary>\n</task-notification>"
    private val labels = listOf(
        "Background task completed: Wait for all VM eval runs to finish",
        "Background task completed: Remove VM worktree, drop temp World DB, clean temp files",
    )

    private fun syntheticLabels(feed: List<FeedItem>) = feed.flatMap(ThreadPresenter::rows).map {
        (it as ThreadRowPresentation.Synthetic).label
    }

    @Test
    fun historyRowsRenderAsSyntheticRows() {
        val loaded = LoadedSession(
            messages = listOf(message("1", withOutputFile), message("2", withoutOutputFile)),
            meta = null,
            total = null,
            truncated = null,
            raw = JsonObject(linkedMapOf()),
        )
        assertEquals(labels, syntheticLabels(LoadedSessionSnapshotMapper.map("thread-1", loaded).feed))
    }

    @Test
    fun severalNoticesInOneMessageEachGetARow() {
        val loaded = LoadedSession(
            messages = listOf(message("1", "$withOutputFile\n\n$withoutOutputFile\n")),
            meta = null,
            total = null,
            truncated = null,
            raw = JsonObject(linkedMapOf()),
        )
        assertEquals(labels, syntheticLabels(LoadedSessionSnapshotMapper.map("thread-1", loaded).feed))
    }

    @Test
    fun cachedSnapshotStillRendersSyntheticRows() {
        val feed = LoadedSessionSnapshotMapper.map(
            "thread-1",
            LoadedSession(listOf(message("1", withOutputFile), message("2", withoutOutputFile)), null, null, null, JsonObject(linkedMapOf())),
        ).feed
        val encoded = ThreadSnapshotCacheCodec.encode("mac", "thread-1", ThreadState(feed = feed))
        val restored = CachedThreadStateMapper.from(offline(encoded), "mac", "thread-1")!!
        assertEquals(labels, syntheticLabels(restored.feed))
    }

    @Test
    fun liveNoticeRendersAsASyntheticRow() {
        var state = ThreadStoreReducer.reduce(ThreadStoreState(), ThreadAction.Activate("mac", 1))
        val raw = JsonObject(
            linkedMapOf(
                "type" to JsonString("task.notification"),
                "threadId" to JsonString("thread-1"),
                "messageId" to JsonString("task_u1"),
                "taskId" to JsonString("busj5onh3"),
                "status" to JsonString("completed"),
                "summary" to JsonString("Background command \"Wait for all VM eval runs to finish\" completed (exit code 0)"),
                "outputFile" to JsonString(outputFile),
                "at" to JsonNumber("5"),
            ),
        )
        state = ThreadStoreReducer.reduce(
            state,
            ThreadAction.Runtime(ScopedThreadEvent(ThreadEventScope("mac", 1), 1, ThreadEventDecoder.decode(raw))),
        )
        assertEquals(labels.take(1), syntheticLabels(state.thread("mac", "thread-1")!!.feed))
    }

    private fun message(id: String, content: String) = ChatMessage(
        id = id,
        role = "user",
        content = content,
        timestamp = id.toLong(),
        raw = JsonObject(linkedMapOf()),
    )

    private fun offline(encoded: CachedThreadWithFeed) = OfflineSnapshot(
        connections = emptyList(),
        credentialRefs = emptyList(),
        nativeCredentialRefs = emptyList(),
        preferences = emptyList(),
        threadPreferences = emptyList(),
        collapsedWorkspaces = emptyList(),
        cachedThreads = listOf(encoded.thread),
        feedRows = encoded.feed,
        outbox = emptyList(),
        outboxAttachments = emptyList(),
        replayStates = emptyList(),
        pendingControlActions = emptyList(),
        quarantinedRecords = emptyList(),
    )
}
