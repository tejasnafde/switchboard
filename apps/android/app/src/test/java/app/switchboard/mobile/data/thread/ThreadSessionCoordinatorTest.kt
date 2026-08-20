package app.switchboard.mobile.data.thread

import app.switchboard.mobile.domain.composer.ComposerAttachment
import app.switchboard.mobile.domain.composer.ComposerDraft
import app.switchboard.mobile.domain.composer.ComposerDraftKey
import app.switchboard.mobile.domain.outbox.EnqueueResult
import app.switchboard.mobile.domain.outbox.OutboxDeliveryState
import app.switchboard.mobile.domain.outbox.OutgoingTurnDraft
import app.switchboard.mobile.domain.outbox.QueuedTurn
import app.switchboard.mobile.domain.outbox.StagedAttachment
import app.switchboard.mobile.domain.remote.ApprovalDecision
import app.switchboard.mobile.domain.remote.ArchiveConversationResult
import app.switchboard.mobile.domain.remote.ChatMessage
import app.switchboard.mobile.domain.remote.CommandBody
import app.switchboard.mobile.domain.remote.LoadedSession
import app.switchboard.mobile.domain.remote.MarkReadResult
import app.switchboard.mobile.domain.remote.ModelOption
import app.switchboard.mobile.domain.remote.ProviderSkill
import app.switchboard.mobile.domain.remote.ProviderInstance
import app.switchboard.mobile.domain.remote.ProviderInstanceSwitchRequest
import app.switchboard.mobile.domain.remote.ProviderInstanceSwitchResult
import app.switchboard.mobile.domain.remote.RemoteOutcome
import app.switchboard.mobile.domain.remote.RemoteRequestKey
import app.switchboard.mobile.domain.remote.RemoteResponse
import app.switchboard.mobile.domain.remote.RuntimeMode
import app.switchboard.mobile.domain.remote.SessionMeta
import app.switchboard.mobile.domain.thread.FeedItem
import app.switchboard.mobile.domain.thread.ThreadEventScope
import app.switchboard.mobile.platform.protocol.Cancelable
import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.RuntimeEventPayload
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ThreadSessionCoordinatorTest {
    @Test
    fun `archive navigates only after backend confirmation and leaves cached state intact`() {
        val remote = FakeThreadSessionRemote(scope)
        val cached = ThreadState(
            feed = listOf(FeedItem.User("cached", "keep me", 1)),
            status = "idle",
        )
        val coordinator = coordinator(remote, cached = cached)
        var navigations = 0

        coordinator.archive { navigations += 1 }
        coordinator.archive { navigations += 1 }

        assertEquals(listOf("thread-1"), remote.archivedThreadIds)
        assertTrue(coordinator.state.value.archive.archiving)
        assertEquals("keep me", (coordinator.currentThread()!!.feed.single() as FeedItem.User).text)

        remote.completeArchive(success("archive", ArchiveConversationResult.Archived))

        assertEquals(1, navigations)
        assertFalse(coordinator.state.value.archive.archiving)
        assertEquals("keep me", (coordinator.currentThread()!!.feed.single() as FeedItem.User).text)
    }

    @Test
    fun `archive failure stays on the thread with draft cache and retryable error`() {
        val remote = FakeThreadSessionRemote(scope)
        val cached = ThreadState(
            feed = listOf(FeedItem.User("cached", "keep history", 1)),
            status = "idle",
        )
        val coordinator = coordinator(
            remote,
            cached = cached,
            initialComposer = ComposerDraft(
                key = ComposerDraftKey("machine", "thread-1"),
                text = "keep draft",
                attachments = emptyList(),
                runtimeMode = "sandbox",
                editingOrigin = null,
            ),
        )
        var navigations = 0

        coordinator.archive { navigations += 1 }
        remote.completeArchive(failure("archive", "archive unavailable"))

        assertEquals(0, navigations)
        assertEquals("archive unavailable", coordinator.state.value.archive.error)
        assertEquals("keep draft", coordinator.state.value.composer.draft)
        assertEquals("keep history", (coordinator.currentThread()!!.feed.single() as FeedItem.User).text)
    }

    @Test
    fun `archive is blocked while the provider is active`() {
        val remote = FakeThreadSessionRemote(scope)
        val coordinator = coordinator(remote, cached = ThreadState(status = "running"))

        coordinator.archive {}

        assertTrue(remote.archivedThreadIds.isEmpty())
        assertEquals("Stop the current turn before archiving", coordinator.state.value.archive.error)
    }

    @Test
    fun `successful history load persists the installed thread snapshot`() {
        val remote = FakeThreadSessionRemote(scope)
        val snapshots = RecordingThreadSnapshotStore()
        val coordinator = coordinator(remote, snapshotStore = snapshots)
        coordinator.start()

        remote.completeLoad(success("load", loadedSession(message("u-1", "user", "saved", 10))))

        assertEquals("saved", (snapshots.saved.single().third.feed.single() as FeedItem.User).text)
        assertEquals("machine", snapshots.saved.single().first)
        assertEquals("thread-1", snapshots.saved.single().second)
    }

    @Test
    fun `accepted runtime reduction persists the latest live thread snapshot`() {
        val remote = FakeThreadSessionRemote(scope)
        val snapshots = RecordingThreadSnapshotStore()
        val coordinator = coordinator(remote, snapshotStore = snapshots)
        coordinator.start()
        remote.completeLoad(success("load", loadedSession()))
        snapshots.saved.clear()

        remote.emit(scope, content("thread-1", "live", "streamed"))

        assertEquals("streamed", (snapshots.saved.single().third.feed.single() as FeedItem.Text).text)
    }

    @Test
    fun `existing thread profile switch uses one atomic request and keeps local thread state intact`() {
        val remote = FakeThreadSessionRemote(scope)
        val coordinator = coordinator(
            remote,
            cached = ThreadState(status = "idle", provider = "codex", instanceId = "codex-work"),
            projectPath = "/repo",
        )

        coordinator.start()
        remote.completeProfiles(
            success(
                "profiles",
                listOf(
                    providerInstance("codex-work", "Work"),
                    providerInstance("codex-tejas", "Tejas"),
                ),
            ),
        )
        remote.completeStart(success("start", startedSession()))

        coordinator.selectProfile("codex-tejas")

        assertEquals(
            listOf("thread-1" to ProviderInstanceSwitchRequest("codex-tejas", "codex-work")),
            remote.profileSwitches,
        )
        assertTrue(coordinator.state.value.profiles.changing)

        remote.completeProfileSwitch(
            success(
                "switch-profile",
                ProviderInstanceSwitchResult.Success(
                    threadId = "thread-1",
                    provider = "codex",
                    previousInstanceId = "codex-work",
                    instanceId = "codex-tejas",
                    instanceName = "Tejas",
                    continuity = "preserved",
                ),
            ),
        )
        assertEquals("codex-tejas", coordinator.state.value.profiles.selectedInstanceId)
        assertFalse(coordinator.state.value.profiles.changing)
        assertEquals(1, remote.startedSessions.size)
    }

    @Test
    fun `profile switch is blocked while the current provider is running`() {
        val remote = FakeThreadSessionRemote(scope)
        val coordinator = coordinator(
            remote,
            cached = ThreadState(status = "running", provider = "codex", instanceId = "codex-work"),
            projectPath = "/repo",
        )

        coordinator.selectProfile("codex-tejas")

        assertTrue(remote.profileSwitches.isEmpty())
        assertEquals("Stop the current turn before switching profile", coordinator.state.value.profiles.error)
    }

    @Test
    fun `profile event from another client refreshes account scoped models and skills`() {
        val remote = FakeThreadSessionRemote(scope)
        val coordinator = coordinator(
            remote,
            cached = ThreadState(status = "idle", provider = "codex", instanceId = "codex-work"),
            projectPath = "/repo",
        )
        coordinator.start()
        val skillRequests = remote.skillThreadIds.size
        val modelRequests = remote.modelThreadIds.size

        remote.emit(
            scope,
            event(
                "session.provider",
                "thread-1",
                "provider" to JsonString("codex"),
                "instanceId" to JsonString("codex-tejas"),
                "instanceName" to JsonString("Tejas"),
            ),
        )

        assertEquals("codex-tejas", coordinator.state.value.profiles.selectedInstanceId)
        assertEquals(skillRequests + 1, remote.skillThreadIds.size)
        assertEquals(modelRequests + 1, remote.modelThreadIds.size)
    }

    @Test
    fun `cached state is immediate and successful load installs stable complete history`() {
        val remote = FakeThreadSessionRemote(scope)
        val cached = ThreadState(
            feed = listOf(FeedItem.User("cached", "saved", 1)),
            unread = 2,
        )
        val coordinator = coordinator(remote, cached = cached)

        val initial = coordinator.state.value.load as ThreadSessionLoad.Loading
        assertEquals("cached", initial.cached?.feed?.single()?.id)

        coordinator.start()

        assertEquals(listOf("thread-1" to 250L), remote.loadedThreads)
        assertEquals(listOf("thread-1"), remote.markedReadThreadIds)
        assertEquals(0, coordinator.currentThread()?.unread)

        remote.completeLoad(
            success(
                "load",
                loadedSession(
                    message("u-1", "user", "hello", 10),
                    message("a-1", "assistant", "hi", 11),
                    message("s-1", "system", "retained notice", 12),
                ),
            ),
        )

        val ready = coordinator.state.value.load as ThreadSessionLoad.Ready
        assertEquals(
            listOf("h-u-1", "h-a-1", "h-s-1"),
            ready.thread.feed.map(FeedItem::id),
        )
        assertEquals("hello", (ready.thread.feed[0] as FeedItem.User).text)
        assertEquals(true, (ready.thread.feed[1] as FeedItem.Text).done)
        assertTrue(ready.thread.feed[2] is FeedItem.Text)
    }

    @Test
    fun `successful history load reattaches session from loaded metadata without replacing history on failure`() {
        val remote = FakeThreadSessionRemote(scope)
        val coordinator = coordinator(remote, projectPath = "/repo", worktreePath = "/repo/.switchboard/wt")
        coordinator.start()
        remote.completeLoad(success("load", loadedSession(message("u-1", "user", "hello", 10))))

        val start = remote.startedSessions.single()
        assertEquals("thread-1", start.threadId)
        assertEquals(app.switchboard.mobile.domain.remote.ProviderKind.Codex, start.provider)
        assertEquals("/repo/.switchboard/wt", start.cwd)
        assertEquals("thread-1", start.resumeSessionId)

        remote.completeStart(failure("start", "provider unavailable"))
        val ready = coordinator.state.value.load as ThreadSessionLoad.Ready
        assertEquals("hello", (ready.thread.feed.single() as FeedItem.User).text)
        assertEquals("provider unavailable", coordinator.state.value.controlMessage)
    }

    @Test
    fun `cached provider reattaches even when history refresh fails`() {
        val remote = FakeThreadSessionRemote(scope)
        val coordinator = coordinator(
            remote,
            cached = ThreadState(provider = "codex"),
            projectPath = "/repo",
        )

        coordinator.start()
        assertEquals(app.switchboard.mobile.domain.remote.ProviderKind.Codex, remote.startedSessions.single().provider)
        remote.completeLoad(failure("load", "history unavailable"))

        assertEquals(1, remote.startedSessions.size)
        assertTrue(coordinator.state.value.load is ThreadSessionLoad.Failed)
    }

    @Test
    fun `successful retry clears an earlier reattach warning`() {
        val remote = FakeThreadSessionRemote(scope)
        val coordinator = coordinator(remote, projectPath = "/repo")
        coordinator.start()
        remote.completeLoad(success("load", loadedSession()))
        remote.completeStart(failure("start", "provider unavailable"))
        assertEquals("provider unavailable", coordinator.state.value.controlMessage)

        coordinator.refresh()
        remote.completeLoadAt(1, success("load", loadedSession()))
        remote.completeStart(success(
            "start",
            app.switchboard.mobile.domain.remote.StartedSession(
                threadId = "thread-1",
                provider = "codex",
                status = "ready",
                cwd = "/repo",
                sessionId = "thread-1",
                raw = emptyJson(),
            ),
        ))

        assertNull(coordinator.state.value.controlMessage)
    }

    @Test
    fun `load failure and mark read failure preserve visible cache`() {
        val remote = FakeThreadSessionRemote(scope)
        val coordinator = coordinator(
            remote,
            cached = ThreadState(feed = listOf(FeedItem.User("cached", "saved", 1))),
        )

        coordinator.start()
        remote.completeMarkRead(failure("mark", "not supported"))
        remote.completeLoad(failure("load", "offline"))

        val failed = coordinator.state.value.load as ThreadSessionLoad.Failed
        assertEquals("offline", failed.message)
        assertEquals("cached", failed.cached?.feed?.single()?.id)
    }

    @Test
    fun `stale scope callbacks and unrelated runtime events cannot mutate this thread`() {
        val remote = FakeThreadSessionRemote(scope)
        val coordinator = coordinator(remote)
        coordinator.start()

        remote.completeLoad(success("load", loadedSession()), scope.copy(generation = 6))
        assertTrue(coordinator.state.value.load is ThreadSessionLoad.Loading)
        remote.completeLoad(success("load", loadedSession()))

        remote.emit(scope.copy(generation = 6), content("thread-1", "old", "wrong generation"))
        remote.emit(scope, content("thread-2", "other", "wrong thread"))
        assertTrue(coordinator.currentThread()?.feed.orEmpty().isEmpty())

        remote.emit(scope, content("thread-1", "live", "accepted"))
        assertEquals("accepted", (coordinator.currentThread()?.feed?.single() as FeedItem.Text).text)
    }

    @Test
    fun `replay gap buffers live events until the replacement snapshot lands`() {
        val remote = FakeThreadSessionRemote(scope)
        val coordinator = coordinator(remote)
        coordinator.start()
        remote.completeLoad(success("load", loadedSession(message("old", "assistant", "old", 1))))

        coordinator.onReplayGap(scope)
        assertTrue(coordinator.currentThread()?.awaitingReseed == true)
        assertEquals(2, remote.loadCallbacks.size)

        remote.emit(scope, content("thread-1", "live", "A", append = false))
        remote.emit(scope, content("thread-1", "live", "B", append = true))
        assertEquals(listOf("h-old"), coordinator.currentThread()?.feed?.map(FeedItem::id))

        remote.completeLoadAt(1, success("load", loadedSession(message("new", "assistant", "new", 2))))

        val thread = coordinator.currentThread()!!
        assertFalse(thread.awaitingReseed)
        assertEquals(listOf("h-new", "m-live-assistant"), thread.feed.map(FeedItem::id))
        assertEquals("AB", (thread.feed.last() as FeedItem.Text).text)
    }

    @Test
    fun `refresh of ready history enters a barrier and preserves buffered events on failure`() {
        val remote = FakeThreadSessionRemote(scope)
        val coordinator = coordinator(remote)
        coordinator.start()
        remote.completeLoad(success("load", loadedSession(message("old", "assistant", "old", 1))))

        coordinator.refresh()
        remote.emit(scope, content("thread-1", "live", "live"))
        remote.completeLoadAt(1, failure("load", "offline"))

        assertTrue(coordinator.currentThread()?.awaitingReseed == true)
        assertEquals(1, coordinator.currentThread()?.bufferedEvents?.size)

        coordinator.refresh()
        assertEquals(1, coordinator.currentThread()?.bufferedEvents?.size)
        remote.completeLoadAt(2, success("load", loadedSession(message("new", "assistant", "new", 2))))

        assertEquals(
            listOf("h-new", "m-live-assistant"),
            coordinator.currentThread()?.feed?.map(FeedItem::id),
        )
    }

    @Test
    fun `composer clears only after durable enqueue and keeps text on failure`() {
        val remote = FakeThreadSessionRemote(scope)
        val enqueue = FakeEnqueuePort()
        val coordinator = coordinator(remote, enqueue = enqueue)

        coordinator.updateDraft("  hello  ")
        enqueue.results += EnqueueResult.StorageFailure("disk full")
        assertEquals(ComposerSubmitResult.Failed("disk full"), coordinator.submit())
        assertEquals("  hello  ", coordinator.state.value.composer.draft)
        assertEquals("disk full", coordinator.state.value.composer.error)

        enqueue.results += durable("origin-1", "hello")
        assertTrue(coordinator.submit() is ComposerSubmitResult.Durable)
        assertEquals("", coordinator.state.value.composer.draft)
        assertNull(coordinator.state.value.composer.error)
        assertEquals("hello", enqueue.drafts.last().text)
        assertEquals("sandbox", enqueue.drafts.last().runtimeMode)
        assertEquals("remote_origin-1", coordinator.currentThread()?.feed?.single()?.id)

        remote.emit(scope, userMessage("thread-1", "origin-1", "hello"))
        assertEquals(listOf("remote_origin-1"), coordinator.currentThread()?.feed?.map(FeedItem::id))
    }

    @Test
    fun `composer synchronously blocks a reentrant send`() {
        val remote = FakeThreadSessionRemote(scope)
        lateinit var coordinator: ThreadSessionCoordinator
        var nested: ComposerSubmitResult? = null
        var calls = 0
        val enqueue = ThreadEnqueuePort { draft ->
            calls += 1
            nested = coordinator.submit()
            durable("origin", draft.text)
        }
        coordinator = coordinator(remote, enqueue = enqueue)
        coordinator.updateDraft("once")

        coordinator.submit()

        assertEquals(1, calls)
        assertEquals(ComposerSubmitResult.Busy, nested)
    }

    @Test
    fun `saved composer restores mode attachments and supports image only send`() {
        val remote = FakeThreadSessionRemote(scope)
        val persistence = FakeComposerPersistence()
        val enqueue = FakeEnqueuePort().also {
            it.results += durable("image-origin", "")
        }
        val saved = ComposerDraft(
            key = ComposerDraftKey("machine", "thread-1"),
            runtimeMode = "plan",
            attachments = listOf(
                ComposerAttachment("image", "/private/drafts/image", "image/png", "image.png"),
            ),
        )
        val coordinator = coordinator(
            remote,
            enqueue = enqueue,
            initialComposer = saved,
            composerPersistence = persistence,
        )

        assertEquals(RuntimeMode.Plan, coordinator.state.value.composer.runtimeMode)
        assertEquals(listOf("image"), coordinator.state.value.composer.attachments.map { it.id })
        assertTrue(coordinator.submit() is ComposerSubmitResult.Durable)
        assertEquals("/private/drafts/image", enqueue.drafts.single().attachments.single().privateSourcePath)
        assertEquals(listOf(saved.key), persistence.cleared)
        assertTrue(coordinator.state.value.composer.attachments.isEmpty())
    }

    @Test
    fun `delayed persistence echoes never roll newer local text or mode backward`() {
        val remote = FakeThreadSessionRemote(scope)
        val coordinator = coordinator(remote)

        coordinator.updateDraft("A")
        coordinator.updateDraft("AB")
        coordinator.selectRuntimeMode(RuntimeMode.Plan)
        remote.completeMode(success("mode", CommandBody(null)))

        coordinator.installComposerDraft(
            ComposerDraft(
                key = ComposerDraftKey("machine", "thread-1"),
                text = "A",
                runtimeMode = "sandbox",
                attachments = listOf(
                    ComposerAttachment("image", "/private/image", "image/png", "image.png"),
                ),
            ),
        )

        assertEquals("AB", coordinator.state.value.composer.draft)
        assertEquals(RuntimeMode.Plan, coordinator.state.value.composer.runtimeMode)
        assertEquals(listOf("image"), coordinator.state.value.composer.attachments.map { it.id })

        coordinator.installComposerDraft(
            ComposerDraft(
                key = ComposerDraftKey("machine", "thread-1"),
                text = "AB",
                runtimeMode = "plan",
                attachments = listOf(
                    ComposerAttachment("image", "/private/image", "image/png", "image.png"),
                ),
            ),
        )

        assertEquals("AB", coordinator.state.value.composer.draft)
        assertEquals(RuntimeMode.Plan, coordinator.state.value.composer.runtimeMode)
    }

    @Test
    fun `late initial hydration and a new queued edit still install authoritative content`() {
        val remote = FakeThreadSessionRemote(scope)
        val coordinator = coordinator(remote)
        val key = ComposerDraftKey("machine", "thread-1")

        coordinator.installComposerDraft(null)
        coordinator.installComposerDraft(
            ComposerDraft(key, text = "restored", runtimeMode = "plan"),
        )

        assertEquals("restored", coordinator.state.value.composer.draft)
        assertEquals(RuntimeMode.Plan, coordinator.state.value.composer.runtimeMode)

        coordinator.updateDraft("newer local")
        val focusBeforeEdit = coordinator.state.value.composer.focusRequest
        coordinator.installComposerDraft(
            ComposerDraft(
                key = key,
                text = "queued edit",
                runtimeMode = "sandbox",
                editingOrigin = "origin-7",
            ),
        )

        assertEquals("queued edit", coordinator.state.value.composer.draft)
        assertEquals(RuntimeMode.Sandbox, coordinator.state.value.composer.runtimeMode)
        assertEquals("origin-7", coordinator.state.value.composer.editingOrigin)
        assertEquals(focusBeforeEdit + 1, coordinator.state.value.composer.focusRequest)
    }

    @Test
    fun `skills load is thread scoped and rejects a stale generation response`() {
        val remote = FakeThreadSessionRemote(scope)
        val coordinator = coordinator(remote)
        coordinator.start()

        assertEquals(listOf("thread-1"), remote.skillThreadIds)
        remote.completeSkills(
            success("skills", listOf(skill("stale"))),
            scope.copy(generation = 6),
        )
        assertTrue(coordinator.state.value.skills.isEmpty())

        remote.completeSkills(success("skills", listOf(skill("commit"))))

        assertEquals(listOf("commit"), coordinator.state.value.skills.map { it.name })
    }

    @Test
    fun `pending interaction ids survive until matching acknowledgement or definite failure`() {
        val remote = FakeThreadSessionRemote(scope)
        val enqueue = FakeEnqueuePort().also {
            it.results += durable("plan-origin", ThreadSessionCoordinator.IMPLEMENT_PLAN_MESSAGE)
        }
        val coordinator = coordinator(remote, enqueue = enqueue)
        coordinator.start()

        coordinator.perform(
            ThreadSessionControl.Approval("approval-1", ApprovalDecision.Deny),
        )
        assertEquals(
            ApprovalDecision.Deny,
            coordinator.state.value.pendingActions.approvalDecisions["approval-1"],
        )
        remote.completeApproval(failure("approval", "rejected"))
        assertFalse("approval-1" in coordinator.state.value.pendingActions.approvalDecisions)

        coordinator.perform(
            ThreadSessionControl.AnswerQuestion("question-1", listOf(listOf("A"))),
        )
        assertTrue("question-1" in coordinator.state.value.pendingActions.questionRequestIds)
        remote.completeQuestion(failure("question", "expired"))
        assertFalse("question-1" in coordinator.state.value.pendingActions.questionRequestIds)

        coordinator.perform(
            ThreadSessionControl.Plan("plan-1", ThreadSessionPlanAction.Implement),
        )
        assertTrue("plan-1" in coordinator.state.value.pendingActions.planIds)
        remote.emit(
            scope.copy(generation = 6),
            userMessage("thread-1", "plan-origin", ThreadSessionCoordinator.IMPLEMENT_PLAN_MESSAGE),
        )
        assertTrue("plan-1" in coordinator.state.value.pendingActions.planIds)
        remote.emit(
            scope,
            userMessage("thread-1", "plan-origin", ThreadSessionCoordinator.IMPLEMENT_PLAN_MESSAGE),
        )
        assertFalse("plan-1" in coordinator.state.value.pendingActions.planIds)
    }

    @Test
    fun `clear visible feed is phone local and preserves thread metadata`() {
        val remote = FakeThreadSessionRemote(scope)
        val coordinator = coordinator(
            remote,
            cached = ThreadState(
                feed = listOf(FeedItem.User("saved", "hello", 1)),
                runtimeMode = "plan",
                provider = "codex",
            ),
        )

        coordinator.clearVisibleFeed()

        assertTrue(coordinator.currentThread()?.feed.orEmpty().isEmpty())
        assertEquals("plan", coordinator.currentThread()?.runtimeMode)
        assertEquals("codex", coordinator.currentThread()?.provider)
        assertTrue(remote.loadedThreads.isEmpty())
    }

    @Test
    fun `refresh does not duplicate an optimistic turn already present in history`() {
        val remote = FakeThreadSessionRemote(scope)
        val enqueue = FakeEnqueuePort().also {
            it.results += durable("origin-1", "hello")
        }
        val coordinator = coordinator(remote, enqueue = enqueue)
        coordinator.start()
        remote.completeLoad(success("load", loadedSession()))
        coordinator.updateDraft("hello")
        coordinator.submit()

        coordinator.refresh()
        remote.completeLoadAt(
            1,
            success("load", loadedSession(message("remote_origin-1", "user", "hello", 123))),
        )

        assertEquals(listOf("h-remote_origin-1"), coordinator.currentThread()?.feed?.map(FeedItem::id))
    }

    @Test
    fun `optimistic image turn remains visible before history refresh`() {
        val remote = FakeThreadSessionRemote(scope)
        val enqueue = FakeEnqueuePort().also {
            it.results += durable(
                origin = "image-origin",
                text = "",
                attachments = listOf(StagedAttachment("/private/screenshot.png", "image/png")),
            )
        }
        val coordinator = coordinator(
            remote,
            enqueue = enqueue,
            initialComposer = ComposerDraft(
                key = ComposerDraftKey("machine", "thread-1"),
                attachments = listOf(
                    ComposerAttachment(
                        id = "screenshot",
                        privateUri = "/private/draft/screenshot.png",
                        mimeType = "image/png",
                        displayName = "screenshot.png",
                    ),
                ),
            ),
        )
        coordinator.start()
        remote.completeLoad(success("load", loadedSession()))

        coordinator.submit()

        val optimistic = coordinator.currentThread()?.feed?.single() as FeedItem.User
        assertEquals("", optimistic.text)
        assertEquals("file:/private/screenshot.png", optimistic.images.single().url)
        assertEquals("image/png", optimistic.images.single().mimeType)
    }

    @Test
    fun `runtime mode and interrupt use distinct absolute remote actions`() {
        val remote = FakeThreadSessionRemote(scope)
        val coordinator = coordinator(remote)

        coordinator.selectRuntimeMode(RuntimeMode.Plan)
        assertEquals(listOf(RuntimeMode.Plan), remote.runtimeModes)
        remote.completeMode(success("mode", CommandBody(null)))
        assertEquals(RuntimeMode.Plan, coordinator.state.value.composer.runtimeMode)

        coordinator.interrupt()
        coordinator.interrupt()
        assertEquals(1, remote.interruptedThreadIds.size)
        remote.completeInterrupt(failure("interrupt", "too late"))
        assertEquals("too late", coordinator.state.value.composer.error)
    }

    @Test
    fun `model discovery ignores superseded and stale generation callbacks`() {
        val remote = FakeThreadSessionRemote(scope)
        val coordinator = coordinator(remote, cached = ThreadState(resolvedModel = "cached-model"))
        coordinator.start()

        assertEquals(listOf("thread-1"), remote.modelThreadIds)
        assertTrue(coordinator.state.value.models.loading)

        coordinator.refreshModels()
        assertEquals(listOf("thread-1", "thread-1"), remote.modelThreadIds)

        remote.completeModelsAt(0, success("models-old", listOf(model("old"))))
        assertTrue(coordinator.state.value.models.loading)
        assertTrue(coordinator.state.value.models.options.isEmpty())

        remote.completeModelsAt(
            1,
            success("models-stale-scope", listOf(model("stale"))),
            ThreadEventScope("machine", 8),
        )
        assertTrue(coordinator.state.value.models.loading)
        assertTrue(coordinator.state.value.models.options.isEmpty())
        assertEquals("cached-model", coordinator.state.value.models.selectedModelId)
    }

    @Test
    fun `empty model discovery completes without discarding the active model`() {
        val remote = FakeThreadSessionRemote(scope)
        val coordinator = coordinator(remote, cached = ThreadState(resolvedModel = "cached-model"))
        coordinator.start()

        remote.completeModelsAt(0, success("models", null))

        assertFalse(coordinator.state.value.models.loading)
        assertTrue(coordinator.state.value.models.options.isEmpty())
        assertEquals("cached-model", coordinator.state.value.models.selectedModelId)
        assertNull(coordinator.state.value.models.error)
    }

    @Test
    fun `model change is not sent when discovery returned no matching option`() {
        val remote = FakeThreadSessionRemote(scope)
        val coordinator = coordinator(remote, cached = ThreadState(resolvedModel = "cached-model"))
        coordinator.start()
        remote.completeModelsAt(0, success("models", emptyList()))

        coordinator.selectModel("missing-model")

        assertTrue(remote.selectedModels.isEmpty())
        assertFalse(coordinator.state.value.models.changing)
        assertEquals("Model is not available for this session", coordinator.state.value.models.error)
    }

    @Test
    fun `successful model change publishes only after the absolute command succeeds`() {
        val remote = FakeThreadSessionRemote(scope)
        val coordinator = coordinator(remote, cached = ThreadState(resolvedModel = "old-model"))
        coordinator.start()
        remote.completeModelsAt(0, success("models", listOf(model("old-model"), model("new-model"))))

        coordinator.selectModel("new-model")

        assertEquals(listOf("thread-1" to "new-model"), remote.selectedModels)
        assertTrue(coordinator.state.value.models.changing)
        assertEquals("old-model", coordinator.state.value.models.selectedModelId)

        remote.completeModelChange(success("set-model", CommandBody(emptyJson())))

        assertFalse(coordinator.state.value.models.changing)
        assertEquals("new-model", coordinator.state.value.models.selectedModelId)
        assertNull(coordinator.state.value.models.error)
    }

    @Test
    fun `runtime model metadata synchronizes the selected model`() {
        val remote = FakeThreadSessionRemote(scope)
        val coordinator = coordinator(remote)
        coordinator.start()
        remote.completeLoad(success("load", loadedSession()))
        remote.completeModelsAt(0, success("models", listOf(model("reported-model"))))

        remote.emit(
            scope,
            event(
                "context_window",
                "thread-1",
                "usedTokens" to JsonNumber("10"),
                "model" to JsonString("reported-model"),
            ),
        )

        assertEquals("reported-model", coordinator.state.value.models.selectedModelId)
    }

    @Test
    fun `rejected model change keeps the previous model and exposes the domain error`() {
        val remote = FakeThreadSessionRemote(scope)
        val coordinator = coordinator(remote, cached = ThreadState(resolvedModel = "old-model"))
        coordinator.start()
        remote.completeModelsAt(0, success("models", listOf(model("old-model"), model("new-model"))))

        coordinator.selectModel("new-model")
        remote.completeModelChange(failure("set-model", "model unavailable"))

        assertFalse(coordinator.state.value.models.changing)
        assertEquals("old-model", coordinator.state.value.models.selectedModelId)
        assertEquals("model unavailable", coordinator.state.value.models.error)
    }

    @Test
    fun `thread controls preserve backend ids and plan behavior matches RN`() {
        val remote = FakeThreadSessionRemote(scope)
        val enqueue = FakeEnqueuePort().also {
            it.results += durable("plan-origin", "Implement the plan you proposed.")
        }
        val coordinator = coordinator(remote, enqueue = enqueue)

        coordinator.perform(
            ThreadSessionControl.Approval("request-1", ApprovalDecision.Deny),
        )
        assertEquals("request-1" to ApprovalDecision.Deny, remote.approvals.single())

        coordinator.perform(
            ThreadSessionControl.AnswerQuestion("question-1", listOf(listOf("A"))),
        )
        assertEquals("question-1", remote.answers.single().first)

        val implement = coordinator.perform(
            ThreadSessionControl.Plan("plan-1", ThreadSessionPlanAction.Implement),
        )
        assertTrue(implement is ThreadControlOutcome.Durable)
        assertEquals("Implement the plan you proposed.", enqueue.drafts.single().text)
        assertEquals("sandbox", enqueue.drafts.single().runtimeMode)
        assertEquals(RuntimeMode.Sandbox, remote.runtimeModes.single())

        coordinator.updateDraft("keep me")
        val beforeFocus = coordinator.state.value.composer.focusRequest
        val iterate = coordinator.perform(
            ThreadSessionControl.Plan("plan-1", ThreadSessionPlanAction.Iterate),
        )
        assertEquals(ThreadControlOutcome.ComposerFocused, iterate)
        assertEquals("keep me", coordinator.state.value.composer.draft)
        assertEquals(beforeFocus + 1, coordinator.state.value.composer.focusRequest)

        val open = coordinator.perform(ThreadSessionControl.OpenFile("edit-1", "/repo", "a.kt"))
        assertEquals(
            ThreadControlOutcome.Unsupported("Opening changed files is not available on mobile yet."),
            open,
        )
    }

    @Test
    fun `request and plan guards reject duplicate taps until failure or matching runtime acknowledgement`() {
        val remote = FakeThreadSessionRemote(scope)
        val enqueue = FakeEnqueuePort().also {
            it.results += durable("plan-origin", "Implement the plan you proposed.")
            it.results += durable("plan-origin-2", "Implement the plan you proposed.")
        }
        val coordinator = coordinator(remote, enqueue = enqueue)
        coordinator.start()
        remote.completeLoad(success("load", loadedSession()))

        val approval = ThreadSessionControl.Approval("request-1", ApprovalDecision.Approve)
        assertEquals(ThreadControlOutcome.Requested, coordinator.perform(approval))
        assertEquals(ThreadControlOutcome.Busy, coordinator.perform(approval))
        remote.completeApproval(failure("approval", "rejected"))
        assertEquals(ThreadControlOutcome.Requested, coordinator.perform(approval))
        remote.emit(scope, requestClosed("thread-1", "request-1"))

        val question = ThreadSessionControl.AnswerQuestion("question-1", listOf(listOf("A")))
        assertEquals(ThreadControlOutcome.Requested, coordinator.perform(question))
        assertEquals(ThreadControlOutcome.Busy, coordinator.perform(question))
        remote.emit(scope, questionAnswered("thread-1", "question-1"))
        assertEquals(ThreadControlOutcome.Requested, coordinator.perform(question))

        val plan = ThreadSessionControl.Plan("plan-1", ThreadSessionPlanAction.Implement)
        assertTrue(coordinator.perform(plan) is ThreadControlOutcome.Durable)
        assertEquals(ThreadControlOutcome.Busy, coordinator.perform(plan))
        remote.emit(scope, userMessage("thread-1", "plan-origin", "Implement the plan you proposed."))
        assertTrue(coordinator.perform(plan) is ThreadControlOutcome.Durable)
    }

    private fun coordinator(
        remote: FakeThreadSessionRemote,
        cached: ThreadState? = null,
        enqueue: ThreadEnqueuePort = FakeEnqueuePort(),
        initialComposer: ComposerDraft? = null,
        composerPersistence: ThreadComposerPersistence = FakeComposerPersistence(),
        snapshotStore: ThreadSnapshotStore = NoOpThreadSnapshotStore,
        projectPath: String? = null,
        worktreePath: String? = null,
    ) = ThreadSessionCoordinator(
        scope = scope,
        threadId = "thread-1",
        initialCached = cached,
        remote = remote,
        enqueue = enqueue,
        clock = ThreadSessionClock { 123L },
        initialComposer = initialComposer,
        composerPersistence = composerPersistence,
        snapshotStore = snapshotStore,
        projectPath = projectPath,
        worktreePath = worktreePath,
    )

    private fun loadedSession(vararg messages: ChatMessage) = LoadedSession(
        messages = messages.toList(),
        meta = SessionMeta("thread-1", "Title", "/repo", "codex", null, emptyJson()),
        total = messages.size.toLong(),
        truncated = false,
        raw = emptyJson(),
    )

    private fun message(id: String, role: String, content: String, at: Long) =
        ChatMessage(id, role, content, at, emptyJson())

    private fun skill(name: String) = ProviderSkill(
        name = name,
        description = null,
        argumentHint = null,
        path = null,
        source = "codex",
        raw = emptyJson(),
    )

    private fun model(id: String) = ModelOption(
        id = id,
        label = id,
        tier = "standard",
        raw = emptyJson(),
    )

    private fun providerInstance(id: String, displayName: String) = ProviderInstance(
        id = id,
        agentType = "codex",
        displayName = displayName,
        accentColor = null,
        authMode = "oauth_dir",
        envKeys = emptyList(),
        oauthDir = null,
        enabled = true,
        createdAt = 1,
        updatedAt = 1,
        raw = emptyJson(),
    )

    private fun startedSession() = app.switchboard.mobile.domain.remote.StartedSession(
        threadId = "thread-1",
        provider = "codex",
        status = "idle",
        cwd = "/repo",
        sessionId = "provider-session",
        raw = emptyJson(),
    )

    private fun content(
        threadId: String,
        messageId: String,
        text: String,
        append: Boolean = false,
    ): RuntimeEventPayload {
        val raw = JsonObject(
            linkedMapOf(
                "type" to JsonString("content"),
                "threadId" to JsonString(threadId),
                "messageId" to JsonString(messageId),
                "text" to JsonString(text),
                "append" to JsonBoolean(append),
                "streamKind" to JsonString("assistant"),
            ),
        )
        return RuntimeEventPayload.parse(raw)!!
    }

    private fun userMessage(threadId: String, origin: String, text: String): RuntimeEventPayload =
        event(
            "user.message",
            threadId,
            "text" to JsonString(text),
            "origin" to JsonString(origin),
            "at" to JsonNumber("123"),
        )

    private fun requestClosed(threadId: String, requestId: String): RuntimeEventPayload =
        event(
            "request.closed",
            threadId,
            "requestId" to JsonString(requestId),
            "decision" to JsonString("approve"),
        )

    private fun questionAnswered(threadId: String, requestId: String): RuntimeEventPayload =
        event(
            "question.answered",
            threadId,
            "requestId" to JsonString(requestId),
            "answers" to app.switchboard.mobile.protocol.JsonArray(
                listOf(app.switchboard.mobile.protocol.JsonArray(listOf(JsonString("A")))),
            ),
        )

    private fun event(
        type: String,
        threadId: String,
        vararg values: Pair<String, app.switchboard.mobile.protocol.JsonValue>,
    ): RuntimeEventPayload = RuntimeEventPayload.parse(
        JsonObject(
            linkedMapOf(
                "type" to JsonString(type),
                "threadId" to JsonString(threadId),
                *values,
            ),
        ),
    )!!

    private fun durable(
        origin: String,
        text: String,
        attachments: List<StagedAttachment> = emptyList(),
    ): EnqueueResult.Durable = EnqueueResult.Durable(
        QueuedTurn(
            connectionId = "machine",
            threadId = "thread-1",
            origin = origin,
            bubbleId = "remote_$origin",
            text = text,
            attachments = attachments,
            runtimeMode = "sandbox",
            createdAtMs = 123,
            attempts = 0,
            nextAttemptAtMs = 0,
            deliveryState = OutboxDeliveryState.Pending,
        ),
    )

    private fun <T> success(operation: String, value: T) = RemoteResponse(
        RemoteRequestKey("machine", 7, operation),
        RemoteOutcome.Success(value),
    )

    private fun <T> failure(operation: String, message: String): RemoteResponse<T> = RemoteResponse(
        RemoteRequestKey("machine", 7, operation),
        RemoteOutcome.Failure(message),
    )

    private fun emptyJson() = JsonObject(linkedMapOf())

    private companion object {
        val scope = ThreadEventScope("machine", 7)
    }
}

private class FakeEnqueuePort : ThreadEnqueuePort {
    val drafts = mutableListOf<OutgoingTurnDraft>()
    val results = ArrayDeque<EnqueueResult>()

    override fun enqueue(draft: OutgoingTurnDraft): EnqueueResult {
        drafts += draft
        return results.removeFirstOrNull() ?: EnqueueResult.StorageFailure("not configured")
    }
}

private class FakeComposerPersistence : ThreadComposerPersistence {
    val saved = mutableListOf<ComposerDraft>()
    val cleared = mutableListOf<ComposerDraftKey>()

    override fun save(draft: ComposerDraft) {
        saved += draft
    }

    override fun clear(key: ComposerDraftKey): Boolean {
        cleared += key
        return true
    }
}

private class RecordingThreadSnapshotStore : ThreadSnapshotStore {
    val saved = mutableListOf<Triple<String, String, ThreadState>>()

    override fun get(connectionId: String, threadId: String): ThreadState? = null

    override fun save(connectionId: String, threadId: String, state: ThreadState) {
        saved += Triple(connectionId, threadId, state)
    }
}

private class FakeThreadSessionRemote(
    override val scope: ThreadEventScope,
) : ThreadSessionRemote {
    var listener: ((ThreadEventScope, RuntimeEventPayload) -> Unit)? = null
    val loadedThreads = mutableListOf<Pair<String, Long>>()
    val loadCallbacks = mutableListOf<(RemoteResponse<LoadedSession>) -> Unit>()
    val markedReadThreadIds = mutableListOf<String>()
    val markReadCallbacks = mutableListOf<(RemoteResponse<MarkReadResult>) -> Unit>()
    val approvals = mutableListOf<Pair<String, ApprovalDecision>>()
    val approvalCallbacks = mutableListOf<(RemoteResponse<CommandBody>) -> Unit>()
    val answers = mutableListOf<Pair<String, List<List<String>>>>()
    val runtimeModes = mutableListOf<RuntimeMode>()
    val modeCallbacks = mutableListOf<(RemoteResponse<CommandBody>) -> Unit>()
    val interruptedThreadIds = mutableListOf<String>()
    val interruptCallbacks = mutableListOf<(RemoteResponse<CommandBody>) -> Unit>()
    val skillThreadIds = mutableListOf<String>()
    val skillCallbacks = mutableListOf<(RemoteResponse<List<ProviderSkill>?>) -> Unit>()
    val modelThreadIds = mutableListOf<String>()
    val modelCallbacks = mutableListOf<(RemoteResponse<List<ModelOption>?>) -> Unit>()
    val selectedModels = mutableListOf<Pair<String, String>>()
    val modelChangeCallbacks = mutableListOf<(RemoteResponse<CommandBody>) -> Unit>()
    val questionCallbacks = mutableListOf<(RemoteResponse<CommandBody>) -> Unit>()
    val profileCallbacks = mutableListOf<(RemoteResponse<List<ProviderInstance>>) -> Unit>()
    val profileSwitches = mutableListOf<Pair<String, ProviderInstanceSwitchRequest>>()
    val profileSwitchCallbacks = mutableListOf<(RemoteResponse<ProviderInstanceSwitchResult>) -> Unit>()
    val archivedThreadIds = mutableListOf<String>()
    val archiveCallbacks = mutableListOf<(RemoteResponse<ArchiveConversationResult>) -> Unit>()

    override fun subscribe(listener: (ThreadEventScope, RuntimeEventPayload) -> Unit): Cancelable {
        this.listener = listener
        return Cancelable { if (this.listener === listener) this.listener = null }
    }

    override fun loadSession(threadId: String, limit: Long, callback: (RemoteResponse<LoadedSession>) -> Unit) {
        loadedThreads += threadId to limit
        loadCallbacks += callback
    }

    val startedSessions = mutableListOf<app.switchboard.mobile.domain.remote.StartSession>()
    val startCallbacks = mutableListOf<(RemoteResponse<app.switchboard.mobile.domain.remote.StartedSession>) -> Unit>()

    override fun startSession(
        input: app.switchboard.mobile.domain.remote.StartSession,
        callback: (RemoteResponse<app.switchboard.mobile.domain.remote.StartedSession>) -> Unit,
    ) {
        startedSessions += input
        startCallbacks += callback
    }

    override fun markRead(threadId: String, callback: (RemoteResponse<MarkReadResult>) -> Unit) {
        markedReadThreadIds += threadId
        markReadCallbacks += callback
    }

    override fun listSkills(
        threadId: String,
        callback: (RemoteResponse<List<ProviderSkill>?>) -> Unit,
    ) {
        skillThreadIds += threadId
        skillCallbacks += callback
    }

    override fun listModels(
        threadId: String,
        callback: (RemoteResponse<List<ModelOption>?>) -> Unit,
    ) {
        modelThreadIds += threadId
        modelCallbacks += callback
    }

    override fun listProviderInstances(callback: (RemoteResponse<List<ProviderInstance>>) -> Unit) {
        profileCallbacks += callback
    }

    override fun switchInstance(
        threadId: String,
        request: ProviderInstanceSwitchRequest,
        callback: (RemoteResponse<ProviderInstanceSwitchResult>) -> Unit,
    ) {
        profileSwitches += threadId to request
        profileSwitchCallbacks += callback
    }

    override fun archiveConversation(
        threadId: String,
        callback: (RemoteResponse<ArchiveConversationResult>) -> Unit,
    ) {
        archivedThreadIds += threadId
        archiveCallbacks += callback
    }

    override fun respondToRequest(
        threadId: String,
        requestId: String,
        decision: ApprovalDecision,
        callback: (RemoteResponse<CommandBody>) -> Unit,
    ) {
        approvals += requestId to decision
        approvalCallbacks += callback
    }

    override fun answerQuestion(
        threadId: String,
        requestId: String,
        answers: List<List<String>>,
        callback: (RemoteResponse<CommandBody>) -> Unit,
    ) {
        this.answers += requestId to answers
        questionCallbacks += callback
    }

    override fun setRuntimeMode(
        threadId: String,
        mode: RuntimeMode,
        callback: (RemoteResponse<CommandBody>) -> Unit,
    ) {
        runtimeModes += mode
        modeCallbacks += callback
    }

    override fun setModel(
        threadId: String,
        model: String,
        callback: (RemoteResponse<CommandBody>) -> Unit,
    ) {
        selectedModels += threadId to model
        modelChangeCallbacks += callback
    }

    override fun interrupt(threadId: String, callback: (RemoteResponse<CommandBody>) -> Unit) {
        interruptedThreadIds += threadId
        interruptCallbacks += callback
    }

    fun emit(scope: ThreadEventScope, payload: RuntimeEventPayload) {
        listener?.invoke(scope, payload)
    }

    fun completeLoad(response: RemoteResponse<LoadedSession>, responseScope: ThreadEventScope = scope) {
        val callback = loadCallbacks.first()
        callback(response.withScope(responseScope))
    }

    fun completeStart(response: RemoteResponse<app.switchboard.mobile.domain.remote.StartedSession>) {
        startCallbacks.removeAt(0)(response)
    }

    fun completeLoadAt(index: Int, response: RemoteResponse<LoadedSession>) {
        loadCallbacks[index](response)
    }

    fun completeMarkRead(response: RemoteResponse<MarkReadResult>) {
        markReadCallbacks.first()(response)
    }

    fun completeMode(response: RemoteResponse<CommandBody>) {
        modeCallbacks.removeAt(0)(response)
    }

    fun completeInterrupt(response: RemoteResponse<CommandBody>) {
        interruptCallbacks.removeAt(0)(response)
    }

    fun completeApproval(response: RemoteResponse<CommandBody>) {
        approvalCallbacks.removeAt(0)(response)
    }

    fun completeQuestion(response: RemoteResponse<CommandBody>) {
        questionCallbacks.removeAt(0)(response)
    }

    fun completeSkills(
        response: RemoteResponse<List<ProviderSkill>?>,
        responseScope: ThreadEventScope = scope,
    ) {
        skillCallbacks.first()(response.withScope(responseScope))
    }

    fun completeModelsAt(
        index: Int,
        response: RemoteResponse<List<ModelOption>?>,
        responseScope: ThreadEventScope = scope,
    ) {
        modelCallbacks[index](response.withScope(responseScope))
    }

    fun completeModelChange(response: RemoteResponse<CommandBody>) {
        modelChangeCallbacks.removeAt(0)(response)
    }

    fun completeProfiles(response: RemoteResponse<List<ProviderInstance>>) {
        profileCallbacks.removeAt(0)(response)
    }

    fun completeProfileSwitch(response: RemoteResponse<ProviderInstanceSwitchResult>) {
        profileSwitchCallbacks.removeAt(0)(response)
    }

    fun completeArchive(response: RemoteResponse<ArchiveConversationResult>) {
        archiveCallbacks.removeAt(0)(response)
    }

    fun <T> RemoteResponse<T>.withScope(scope: ThreadEventScope) = copy(
        key = key.copy(connectionId = scope.connectionId, generation = scope.generation),
    )
}
