package app.switchboard.mobile.data.thread

import app.switchboard.mobile.domain.thread.FeedItem
import app.switchboard.mobile.domain.thread.ThreadEventDecoder
import app.switchboard.mobile.domain.thread.ThreadEventScope
import app.switchboard.mobile.domain.thread.ThreadRuntimeEvent
import app.switchboard.mobile.domain.thread.ThreadSnapshot
import app.switchboard.mobile.domain.remote.MessageImage
import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ThreadStoreReducerTest {
    @Test
    fun userMessageUsesDisplayBodyAndImagesAndKeepsOriginDedupe() {
        var state = reduce(ThreadStoreState(), ThreadAction.Activate("mac-a", 1))
        val raw = event(
            "user.message",
            "text" to s("context wrapper\n\nvisible"),
            "displayBody" to s("visible"),
            "pillsMeta" to obj(
                "selection-1" to obj(
                    "label" to s("Admin panel"),
                    "kind" to s("chat-message"),
                ),
            ),
            "images" to arr(obj("url" to s("data:image/png;base64,AAA"), "mimeType" to s("image/png"))),
            "origin" to s("phone-image"),
            "at" to n(1),
        )
        state = ingest(state, "mac-a", 1, 1, raw)
        state = ingest(state, "mac-a", 1, 2, raw)

        val users = state.thread("mac-a", "thread-1")!!.feed.filterIsInstance<FeedItem.User>()
        assertEquals(1, users.size)
        assertEquals("visible", users.single().text)
        assertEquals("data:image/png;base64,AAA", users.single().images.single().url)
        assertEquals("Admin panel", users.single().pillsMeta["selection-1"]?.label)
    }

    @Test
    fun syntheticContextUserMessageIsNotRendered() {
        var state = reduce(ThreadStoreState(), ThreadAction.Activate("mac-a", 1))
        state = ingest(
            state,
            "mac-a",
            1,
            1,
            event(
                "user.message",
                "text" to s("<environment_context>\n<cwd>/repo</cwd>\n</environment_context>"),
                "at" to n(1),
            ),
        )
        assertTrue(state.thread("mac-a", "thread-1")!!.feed.isEmpty())
    }
    @Test
    fun identicalThreadIdsAreIsolatedByConnectionAndStaleGenerationsAreIgnored() {
        var state = ThreadStoreState()
        state = reduce(state, ThreadAction.Activate("mac-a", 4))
        state = reduce(state, ThreadAction.Activate("mac-b", 9))
        state = ingest(state, "mac-a", 4, 1, event("status", "status" to s("running")))
        state = ingest(state, "mac-b", 9, 1, event("status", "status" to s("error")))
        state = ingest(state, "mac-a", 3, 2, event("status", "status" to s("stopped")))

        assertEquals("running", state.thread("mac-a", "thread-1")!!.status)
        assertEquals("error", state.thread("mac-b", "thread-1")!!.status)
        assertEquals(1, state.thread("mac-a", "thread-1")!!.eventJournal.size)
    }

    @Test
    fun contentCoalescingIsLosslessButNeverCrossesAFifoBarrier() {
        val scope = ThreadEventScope("mac-a", 4)
        val batch = listOf(
            scoped(scope, 1, event("content", "messageId" to s("m1"), "text" to s("Hel"), "streamKind" to s("assistant"))),
            scoped(scope, 2, event("content", "messageId" to s("m1"), "text" to s("lo"), "append" to b(true), "streamKind" to s("assistant"))),
            scoped(scope, 3, event("tool.started", "toolId" to s("t1"), "toolName" to s("Read"), "input" to obj())),
            scoped(scope, 4, event("content", "messageId" to s("m1"), "text" to s("!"), "append" to b(true), "streamKind" to s("assistant"))),
            scoped(scope, 5, event("content", "messageId" to s("m2"), "text" to s("why"), "streamKind" to s("reasoning"))),
            scoped(scope, 6, event("content", "messageId" to s("m2"), "text" to s("?"), "append" to b(true), "streamKind" to s("reasoning"))),
        )

        val coalesced = ThreadEventCoalescer.coalesce(batch)
        assertEquals(listOf(2L, 3L, 4L, 6L), coalesced.map { it.sequence })
        assertEquals(2, coalesced.first().rawPayloads.size)

        var state = reduce(ThreadStoreState(), ThreadAction.Activate("mac-a", 4))
        coalesced.forEach { state = reduce(state, ThreadAction.Runtime(it)) }
        val thread = state.thread("mac-a", "thread-1")!!
        assertEquals(listOf("m-m1-assistant", "t-t1", "m-m2-reasoning"), thread.feed.map { it.id })
        assertEquals("Hello!", (thread.feed[0] as FeedItem.Text).text)
        assertEquals("why?", (thread.feed[2] as FeedItem.Text).text)
        assertEquals(6, thread.eventJournal.sumOf { it.rawPayloads.size })
    }

    @Test
    fun userEchoAndStableCardsDeduplicateWhileUpdatesReplaceInPlace() {
        var state = reduce(ThreadStoreState(), ThreadAction.Activate("mac-a", 1))
        val events = listOf(
            event("user.message", "text" to s("hello"), "origin" to s("origin-1"), "at" to n(1)),
            event("user.message", "text" to s("hello"), "origin" to s("origin-1"), "at" to n(1)),
            event("tool.started", "toolId" to s("tool-1"), "toolName" to s("Read"), "input" to obj()),
            event("tool.started", "toolId" to s("tool-1"), "toolName" to s("Read"), "input" to obj("path" to s("b"))),
            event("tool.completed", "toolId" to s("tool-1"), "output" to s("done")),
            event("file.edited", "turnId" to s("turn"), "fileEditId" to s("edit"), "repoRoot" to s("/repo"), "relPath" to s("a"), "changeKind" to s("modify"), "oldContent" to s("old"), "newContent" to s("one")),
            event("file.edited", "turnId" to s("turn"), "fileEditId" to s("edit"), "repoRoot" to s("/repo"), "relPath" to s("a"), "changeKind" to s("modify"), "oldContent" to s("old"), "newContent" to s("two")),
            event("todo.updated", "todoId" to s("todo"), "items" to arr(obj("text" to s("A"), "status" to s("pending")))),
            event("todo.updated", "todoId" to s("todo"), "items" to arr(obj("text" to s("A"), "status" to s("completed")))),
        )
        events.forEachIndexed { index, raw -> state = ingest(state, "mac-a", 1, index.toLong(), raw) }

        val feed = state.thread("mac-a", "thread-1")!!.feed
        assertEquals(4, feed.size)
        assertEquals("remote_origin-1", feed[0].id)
        assertEquals("done", (feed[1] as FeedItem.Tool).output)
        assertEquals("two", (feed[2] as FeedItem.FileEdit).newContent)
        assertEquals("completed", (feed[3] as FeedItem.Todo).items.single().status)
    }

    @Test
    fun toolCompletionWithoutItsStartDoesNotCreateAnUnknownToolCard() {
        var state = reduce(ThreadStoreState(), ThreadAction.Activate("mac-a", 1))

        state = ingest(
            state,
            "mac-a",
            1,
            1,
            event("tool.completed", "toolId" to s("missing-start"), "output" to s("large diagnostic")),
        )

        val thread = state.thread("mac-a", "thread-1")!!
        assertTrue(thread.feed.filterIsInstance<FeedItem.Tool>().isEmpty())
        assertEquals(1, thread.eventJournal.size)
    }

    @Test
    fun everyKnownEventProjectsToFeedOrThreadMetadataWithoutDataLoss() {
        var state = reduce(ThreadStoreState(), ThreadAction.Activate("mac-a", 1))
        val events = allKnownEvents()
        events.forEachIndexed { index, raw -> state = ingest(state, "mac-a", 1, index.toLong() + 1, raw) }
        val thread = state.thread("mac-a", "thread-1")!!

        assertEquals(events.size, thread.eventJournal.sumOf { it.rawPayloads.size })
        assertEquals("idle", thread.status)
        assertEquals("session-1", thread.sessionId)
        assertEquals("codex", thread.provider)
        assertNull(thread.instanceId)
        assertEquals(50L, thread.usedTokens)
        assertEquals(100L, thread.maxTokens)
        assertEquals("gpt-5.6-luna", thread.resolvedModel)
        assertEquals(listOf("low", "high"), thread.availableVariants)
        assertEquals("high", thread.currentVariant)
        assertEquals(0, thread.unread)
        assertEquals("/worktree", thread.drift?.worktreePath)
        assertEquals("fable", thread.spendBlock?.model)
        assertTrue(thread.feed.any { it is FeedItem.Retry })
        assertTrue(thread.feed.any { it is FeedItem.Peer })
        assertTrue(thread.feed.any { it is FeedItem.Plan })
        assertTrue(thread.feed.any { it is FeedItem.Question && it.answers == listOf(listOf("A")) })
        assertTrue(thread.feed.any { it is FeedItem.Approval && it.state == "approve" })
        assertTrue(thread.feed.filterIsInstance<FeedItem.Text>().all { it.done })
        assertTrue(thread.feed.filterIsInstance<FeedItem.Tool>().all { it.state == "done" })
    }

    @Test
    fun unknownAndMalformedEventsAppendVisibleRawNotices() {
        var state = reduce(ThreadStoreState(), ThreadAction.Activate("mac-a", 1))
        state = ingest(state, "mac-a", 1, 1, event("provider.future", "payload" to n(3)))
        state = ingest(state, "mac-a", 1, 2, event("content", "text" to s("bad")))

        val notices = state.thread("mac-a", "thread-1")!!.feed.filterIsInstance<FeedItem.RawNotice>()
        assertEquals(2, notices.size)
        assertEquals("provider.future", notices[0].eventType)
        assertEquals(n(3), notices[0].raw.values["payload"])
        assertTrue(notices[1].text.contains("Malformed content"))
    }

    @Test
    fun replayGapBuffersLiveEventsThenReplacesAndReplaysInFifoOrder() {
        var state = reduce(ThreadStoreState(), ThreadAction.Activate("mac-a", 7))
        state = reduce(
            state,
            ThreadAction.InstallSnapshot(
                ThreadEventScope("mac-a", 7),
                ThreadSnapshot("thread-1", listOf(FeedItem.User("history-old", "old", 1))),
            ),
        )
        state = reduce(state, ThreadAction.ReplayGap(ThreadEventScope("mac-a", 7)))
        state = ingest(state, "mac-a", 7, 11, event("content", "messageId" to s("live"), "text" to s("A"), "streamKind" to s("assistant")))
        state = ingest(state, "mac-a", 7, 12, event("tool.started", "toolId" to s("live-tool"), "toolName" to s("Read"), "input" to obj()))
        state = ingest(state, "mac-a", 7, 13, event("content", "messageId" to s("live"), "text" to s("B"), "append" to b(true), "streamKind" to s("assistant")))

        val waiting = state.thread("mac-a", "thread-1")!!
        assertTrue(waiting.awaitingReseed)
        assertEquals(listOf("history-old"), waiting.feed.map { it.id })
        assertEquals(3, waiting.bufferedEvents.sumOf { it.rawPayloads.size })

        state = reduce(
            state,
            ThreadAction.InstallSnapshot(
                ThreadEventScope("mac-a", 7),
                ThreadSnapshot("thread-1", listOf(FeedItem.User("history-new", "new", 2))),
            ),
        )
        val reseeded = state.thread("mac-a", "thread-1")!!
        assertFalse(reseeded.awaitingReseed)
        assertEquals(listOf("history-new", "m-live-assistant", "t-live-tool"), reseeded.feed.map { it.id })
        assertEquals("AB", (reseeded.feed[1] as FeedItem.Text).text)
        assertTrue(reseeded.bufferedEvents.isEmpty())
    }

    @Test
    fun replayGapCollapsesSnapshotAndBufferedEchoForTheSamePhoneOrigin() {
        val image = MessageImage(
            "data:image/png;base64,AAA",
            "image/png",
            null,
        )
        var state = reduce(ThreadStoreState(), ThreadAction.Activate("mac-a", 7))
        state = reduce(state, ThreadAction.ReplayGap(ThreadEventScope("mac-a", 7)))
        state = ingest(
            state,
            "mac-a",
            7,
            11,
            event(
                "user.message",
                "text" to s("photo"),
                "origin" to s("origin-1"),
                "images" to arr(obj("url" to s(image.url), "mimeType" to s("image/png"))),
                "at" to n(2),
            ),
        )

        state = reduce(
            state,
            ThreadAction.InstallSnapshot(
                ThreadEventScope("mac-a", 7),
                ThreadSnapshot(
                    "thread-1",
                    listOf(FeedItem.User("h-remote_origin-1", "photo", 2, listOf(image))),
                ),
            ),
        )

        val users = state.thread("mac-a", "thread-1")!!.feed.filterIsInstance<FeedItem.User>()
        assertEquals(1, users.size)
        assertEquals("remote_origin-1", users.single().id)
        assertEquals(image.url, users.single().images.single().url)
    }

    @Test
    fun ordinarySnapshotNeverReplacesLiveStateAndWrongGenerationCannotSatisfyGap() {
        var state = reduce(ThreadStoreState(), ThreadAction.Activate("mac-a", 2))
        state = ingest(state, "mac-a", 2, 1, event("user.message", "text" to s("live"), "at" to n(1)))
        state = reduce(state, ThreadAction.InstallSnapshot(ThreadEventScope("mac-a", 2), ThreadSnapshot("thread-1", listOf(FeedItem.User("history", "history", 0)))))
        assertEquals(listOf("remote_1"), state.thread("mac-a", "thread-1")!!.feed.map { it.id })

        state = reduce(state, ThreadAction.ReplayGap(ThreadEventScope("mac-a", 2)))
        state = reduce(state, ThreadAction.InstallSnapshot(ThreadEventScope("mac-a", 1), ThreadSnapshot("thread-1", listOf(FeedItem.User("wrong", "wrong", 0)))))
        assertTrue(state.thread("mac-a", "thread-1")!!.awaitingReseed)
    }

    @Test
    fun postGapEventForPreviouslyUnknownThreadWaitsForSnapshotAndCompletionBarrier() {
        var state = reduce(ThreadStoreState(), ThreadAction.Activate("mac-a", 8))
        state = reduce(state, ThreadAction.ReplayGap(ThreadEventScope("mac-a", 8)))
        val otherThread = eventFor(
            "thread-new",
            "content",
            "messageId" to s("live"),
            "text" to s("after-gap"),
            "streamKind" to s("assistant"),
        )
        state = ingest(state, "mac-a", 8, 1, otherThread)

        val waiting = state.thread("mac-a", "thread-new")!!
        assertTrue(waiting.awaitingReseed)
        assertTrue(waiting.feed.isEmpty())
        assertEquals(1, waiting.bufferedEvents.size)
        assertTrue(ThreadEventScope("mac-a", 8) in state.reseedingConnections)

        state = reduce(
            state,
            ThreadAction.InstallSnapshot(
                ThreadEventScope("mac-a", 8),
                ThreadSnapshot("thread-new", listOf(FeedItem.User("history", "before-gap", 0))),
            ),
        )
        state = reduce(state, ThreadAction.CompleteReseed(ThreadEventScope("mac-a", 8)))

        assertEquals(listOf("history", "m-live-assistant"), state.thread("mac-a", "thread-new")!!.feed.map { it.id })
        assertFalse(ThreadEventScope("mac-a", 8) in state.reseedingConnections)
    }

    @Test
    fun completionBarrierCannotOpenWhileANewlyDiscoveredThreadStillAwaitsSnapshot() {
        var state = reduce(ThreadStoreState(), ThreadAction.Activate("mac-a", 8))
        state = reduce(state, ThreadAction.ReplayGap(ThreadEventScope("mac-a", 8)))
        state = ingest(
            state,
            "mac-a",
            8,
            1,
            eventFor("thread-new", "status", "status" to s("running")),
        )

        state = reduce(state, ThreadAction.CompleteReseed(ThreadEventScope("mac-a", 8)))

        assertTrue(ThreadEventScope("mac-a", 8) in state.reseedingConnections)
        assertTrue(state.thread("mac-a", "thread-new")!!.awaitingReseed)
    }

    @Test
    fun viewingThreadDoesNotIncrementUnreadButBackgroundThreadDoesOncePerMessage() {
        var state = reduce(ThreadStoreState(), ThreadAction.Activate("mac-a", 1))
        state = reduce(state, ThreadAction.SetViewing("mac-a", "thread-1", true))
        state = ingest(state, "mac-a", 1, 1, event("content", "messageId" to s("visible"), "text" to s("A"), "streamKind" to s("assistant")))
        state = ingest(state, "mac-a", 1, 2, event("content", "messageId" to s("visible"), "text" to s("B"), "append" to b(true), "streamKind" to s("assistant")))
        assertEquals(0, state.thread("mac-a", "thread-1")!!.unread)

        state = reduce(state, ThreadAction.SetViewing("mac-a", "thread-1", false))
        state = ingest(state, "mac-a", 1, 3, event("content", "messageId" to s("background"), "text" to s("C"), "streamKind" to s("assistant")))
        state = ingest(state, "mac-a", 1, 4, event("content", "messageId" to s("background"), "text" to s("D"), "append" to b(true), "streamKind" to s("assistant")))
        assertEquals(1, state.thread("mac-a", "thread-1")!!.unread)

        state = reduce(state, ThreadAction.SetViewing("mac-a", "thread-1", true))
        assertEquals(0, state.thread("mac-a", "thread-1")!!.unread)
    }

    private fun allKnownEvents(): List<JsonObject> = listOf(
        event("content", "messageId" to s("m1"), "text" to s("answer"), "streamKind" to s("assistant")),
        event("content", "messageId" to s("m2"), "text" to s("thought"), "streamKind" to s("reasoning")),
        event("content", "messageId" to s("m3"), "text" to s("draft"), "streamKind" to s("plan")),
        event("user.message", "text" to s("hi"), "at" to n(1)),
        event("tool.started", "toolId" to s("tool"), "toolName" to s("Read"), "input" to obj()),
        event("tool.completed", "toolId" to s("tool"), "output" to s("ok")),
        event("tool.denied", "toolName" to s("Write"), "reason" to s("denied"), "mode" to s("plan")),
        event("request.opened", "requestId" to s("request"), "requestType" to s("tool"), "toolName" to s("Bash"), "detail" to s("run")),
        event("request.closed", "requestId" to s("request"), "decision" to s("approve")),
        event("turn.retrying", "turnId" to s("turn"), "message" to s("retry")),
        event("error", "message" to s("failed"), "turnId" to s("turn")),
        event("status", "status" to s("running")),
        event("session", "sessionId" to s("session-1")),
        event("session.provider", "provider" to s("codex"), "instanceId" to JsonNull, "instanceName" to JsonNull),
        event("context_window", "usedTokens" to n(44), "maxTokens" to n(100), "model" to s("gpt-5.6-luna"), "costUsd" to n("0.5")),
        event("model.variants", "modelId" to s("gpt-5.6-luna"), "availableVariants" to arr(s("low"), s("high")), "currentVariant" to s("high")),
        event("plan.proposed", "planId" to s("plan"), "planMarkdown" to s("# Plan")),
        event("question.asked", "requestId" to s("question"), "questions" to arr(question())),
        event("question.answered", "requestId" to s("question"), "answers" to arr(arr(s("A")))),
        event("file.edited", "turnId" to s("turn"), "fileEditId" to s("edit"), "repoRoot" to s("/repo"), "relPath" to s("a"), "changeKind" to s("modify"), "oldContent" to s("old"), "newContent" to s("new")),
        event("worktree.drift", "worktreePath" to s("/worktree"), "branch" to s("sb/test")),
        event("spend.blocked", "instanceId" to JsonNull, "model" to s("fable"), "reason" to s("disabled"), "scope" to s("not-provisioned"), "resetsAtMs" to JsonNull),
        event("thread.read", "at" to n(3)),
        event("peer.message", "direction" to s("received"), "initiator" to s("agent"), "messageId" to s("peer"), "peerThreadId" to s("other"), "peerLabel" to s("Other"), "text" to s("hello"), "at" to n(4)),
        event("todo.updated", "todoId" to s("todo"), "items" to arr(obj("text" to s("Ship"), "status" to s("completed")))),
        event("turn.completed", "turnId" to s("turn"), "costUsd" to n("0.6"), "usedTokens" to n(50), "maxTokens" to n(100), "numTurns" to n(1), "durationMs" to n(1200)),
    )

    private fun question() = obj(
        "id" to s("choice"), "header" to s("Choose"), "question" to s("Which?"),
        "options" to arr(obj("label" to s("A"))), "multiSelect" to b(false),
    )

    private fun reduce(state: ThreadStoreState, action: ThreadAction) = ThreadStoreReducer.reduce(state, action)

    @Test
    fun replayedErrorAndNoticeEventsDoNotDuplicateFeedIds() {
        var state = reduce(ThreadStoreState(), ThreadAction.Activate("mac-a", 1))
        val failure = event("error", "message" to s("boom"), "turnId" to s("turn-1"))
        val unknown = event("totally.new.event", "payload" to s("x"))

        state = ingest(state, "mac-a", 1, 1, failure)
        state = ingest(state, "mac-a", 1, 1, failure)
        state = ingest(state, "mac-a", 1, 2, unknown)
        state = ingest(state, "mac-a", 1, 2, unknown)

        val feed = state.thread("mac-a", "thread-1")!!.feed
        assertEquals(feed.size, feed.map { it.id }.toSet().size)
        assertEquals(1, feed.filterIsInstance<FeedItem.Error>().size)
        assertEquals(1, feed.filterIsInstance<FeedItem.RawNotice>().size)
    }

    @Test
    fun identicalErrorsAtDifferentSequencesStayDistinct() {
        var state = reduce(ThreadStoreState(), ThreadAction.Activate("mac-a", 1))
        val failure = event("error", "message" to s("boom"), "turnId" to s("turn-1"))

        state = ingest(state, "mac-a", 1, 1, failure)
        state = ingest(state, "mac-a", 1, 2, failure)

        val feed = state.thread("mac-a", "thread-1")!!.feed
        assertEquals(2, feed.filterIsInstance<FeedItem.Error>().size)
        assertEquals(feed.size, feed.map { it.id }.toSet().size)
    }

    @Test
    fun unsequencedIdenticalDenialsStayDistinctRows() {
        var state = reduce(ThreadStoreState(), ThreadAction.Activate("mac-a", 1))
        val denial = event(
            "tool.denied",
            "toolName" to s("Bash"),
            "reason" to s("Plan mode blocks Bash"),
            "mode" to s("plan"),
        )

        state = ingestUnsequenced(state, "mac-a", 1, denial)
        state = ingestUnsequenced(state, "mac-a", 1, denial)

        val feed = state.thread("mac-a", "thread-1")!!.feed
        assertEquals(2, feed.filterIsInstance<FeedItem.Denial>().size)
        assertEquals(feed.size, feed.map { it.id }.toSet().size)
    }

    @Test
    fun unsequencedIdenticalErrorsStayDistinctRows() {
        var state = reduce(ThreadStoreState(), ThreadAction.Activate("mac-a", 1))
        val failure = event("error", "message" to s("boom"), "turnId" to s("turn-1"))

        state = ingestUnsequenced(state, "mac-a", 1, failure)
        state = ingestUnsequenced(state, "mac-a", 1, failure)

        val feed = state.thread("mac-a", "thread-1")!!.feed
        assertEquals(2, feed.filterIsInstance<FeedItem.Error>().size)
        assertEquals(feed.size, feed.map { it.id }.toSet().size)
    }

    private fun ingestUnsequenced(state: ThreadStoreState, connectionId: String, generation: Long, raw: JsonObject) =
        reduce(
            state,
            ThreadAction.Runtime(
                ScopedThreadEvent(ThreadEventScope(connectionId, generation), null, ThreadEventDecoder.decode(raw)),
            ),
        )

    private fun ingest(state: ThreadStoreState, connectionId: String, generation: Long, sequence: Long, raw: JsonObject) =
        reduce(state, ThreadAction.Runtime(scoped(ThreadEventScope(connectionId, generation), sequence, raw)))

    private fun scoped(scope: ThreadEventScope, sequence: Long, raw: JsonObject) =
        ScopedThreadEvent(scope, sequence, ThreadEventDecoder.decode(raw))

    private fun event(type: String, vararg fields: Pair<String, JsonValue>) =
        obj("type" to s(type), "threadId" to s("thread-1"), *fields, "future" to s("kept"))

    private fun eventFor(threadId: String, type: String, vararg fields: Pair<String, JsonValue>) =
        obj("type" to s(type), "threadId" to s(threadId), *fields, "future" to s("kept"))

    private fun obj(vararg fields: Pair<String, JsonValue>) = JsonObject(linkedMapOf(*fields))
    private fun arr(vararg values: JsonValue) = JsonArray(values.toList())
    private fun s(value: String) = JsonString(value)
    private fun b(value: Boolean) = JsonBoolean(value)
    private fun n(value: Long) = JsonNumber(value.toString())
    private fun n(value: String) = JsonNumber(value)
}
