package app.switchboard.mobile.ui.navigation

import app.switchboard.mobile.data.remote.EmptyBrowseSnapshotStore
import app.switchboard.mobile.data.remote.EmptyNewSessionWorktreeCreationStore
import app.switchboard.mobile.data.remote.PhoneDemoFixture
import app.switchboard.mobile.data.remote.PhoneDemoTestFixture
import app.switchboard.mobile.data.remote.VirtualScheduler
import app.switchboard.mobile.data.thread.NoOpThreadSnapshotStore
import app.switchboard.mobile.domain.composer.ComposerDraft
import app.switchboard.mobile.domain.composer.ComposerDraftKey
import app.switchboard.mobile.domain.connection.ConnectionStatus
import app.switchboard.mobile.domain.outbox.EnqueueResult
import app.switchboard.mobile.domain.outbox.OutgoingTurnDraft
import app.switchboard.mobile.platform.protocol.ProtocolHubEvent
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.ui.connections.ConnectionsLoadState
import java.lang.reflect.Modifier
import java.util.IdentityHashMap
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class PhoneDemoRuntimeTest {
    private val scheduler = VirtualScheduler()
    private var schedulerClosed = false
    private val controller = PhoneDemoController(
        readFixture = PhoneDemoTestFixture::json,
        nowMs = { PhoneDemoTestFixture.NOW },
        newScheduler = { scheduler to { schedulerClosed = true } },
        log = { _, _ -> },
    )

    @Test
    fun theFixtureNamesTheDemoConnection() {
        val fixture = PhoneDemoFixture.parse(PhoneDemoTestFixture.json(), 0)
        assertEquals(PhoneDemoNavigationRuntime.CONNECTION_ID, fixture.connectionId)
    }

    @Test
    fun startOpensOneConnectedMachineAndLeaveDropsIt() {
        val runtime = requireNotNull(controller.start())
        assertSame(runtime, controller.start())
        assertSame(runtime, controller.active.value)
        val machine = (runtime.connections as ConnectionsLoadState.Ready).connections.single()
        assertEquals("demo" to "Demo machine", machine.id to machine.label)
        assertEquals(ConnectionStatus.Connected, runtime.statuses.value.getValue("demo").status)
        assertNotNull(runtime.lease("demo"))
        assertNull(runtime.lease("someone-else"))

        controller.leave()
        assertNull(controller.active.value)
        assertNull(runtime.lease("demo"))
        assertNull(runtime.rpc.scope)
        assertTrue(schedulerClosed)
    }

    @Test
    fun aNewSessionNeverReusesTheLastOnesScope() {
        val first = requireNotNull(controller.start()).lease("demo")!!.scope
        controller.leave()
        val second = requireNotNull(controller.start()).lease("demo")!!.scope
        assertTrue(first.generation != second.generation)
        controller.leave()
    }

    @Test
    fun aSendGoesToTheDemoBackendAndEchoesBackWithItsOrigin() {
        val runtime = requireNotNull(controller.start())
        val scope = runtime.lease("demo")!!.scope
        val events = mutableListOf<ProtocolHubEvent>()
        runtime.observeProtocolEvents(scope) { events += it }
        scheduler.advanceBy(10_000)
        events.clear()
        val result = runtime.enqueue(
            OutgoingTurnDraft(
                connectionId = "demo",
                threadId = "demo-done",
                text = "hello",
                attachments = emptyList(),
                runtimeMode = null,
                createdAtMs = 1,
            ),
        )
        val turn = (result as EnqueueResult.Durable).turn
        scheduler.advanceBy(5_000)
        val echo = events.filterIsInstance<ProtocolHubEvent.Runtime>().first().event
        assertEquals("user.message", echo.type)
        assertEquals(JsonString(turn.origin), echo.raw.values["origin"])
        assertEquals(JsonString("idle"), events.filterIsInstance<ProtocolHubEvent.Runtime>().last().event.raw.values["status"])
        assertTrue(runtime.queuedTurns.value.isEmpty())
        controller.leave()
    }

    @Test
    fun theBrowseActivityShowsTheApprovalAndTheRunningTurn() {
        val runtime = requireNotNull(controller.start())
        scheduler.advanceBy(1_000)
        val activity = runtime.browseActivity(runtime.lease("demo")!!.scope).value
        assertEquals("running", activity.getValue("demo-running").status)
        assertNotNull(activity["demo-approval"])
        controller.leave()
    }

    @Test
    fun nothingTheDemoDoesReachesAStore() {
        val runtime = requireNotNull(controller.start())
        val key = ComposerDraftKey("demo", "demo-done")
        runtime.saveComposerDraft(ComposerDraft(key, text = "draft"))
        runtime.saveCollapsedWorkspaceIds("demo", setOf("w"))
        runtime.saveReviewFilters("demo", runtime.reviewFilters("demo", emptySnapshot()))
        runtime.setFollowUpDefault(app.switchboard.mobile.domain.thread.TurnDelivery.Queue)
        assertEquals("draft", runtime.composerDrafts.value.getValue(key).text)
        assertSame(NoOpThreadSnapshotStore, runtime.threadSnapshots)
        assertSame(EmptyBrowseSnapshotStore, runtime.browseSnapshotStore(emptySnapshot()))
        assertSame(EmptyNewSessionWorktreeCreationStore, runtime.worktreeCreations)
        assertNull(runtime.cachedThread("demo", "demo-done"))
        controller.leave()
    }

    /**
     * Walks everything the demo holds. No socket, HTTP client, dialer, Room
     * database or stored repository is reachable from it, so the demo can
     * neither open a connection nor write a row.
     */
    @Test
    fun theDemoHoldsNoSocketHttpClientOrDatabase() {
        val runtime = requireNotNull(controller.start())
        scheduler.advanceBy(3_000)
        val reached = reachableClassNames(controller)
        val forbidden = listOf(
            "okhttp3.",
            "androidx.room.",
            "android.database.",
            "app.switchboard.mobile.platform.protocol.LineDialer",
            "app.switchboard.mobile.platform.protocol.OkHttpWebSocketDialer",
            "app.switchboard.mobile.platform.protocol.AuthenticatedWsCoordinator",
            "app.switchboard.mobile.data.connection.",
            "app.switchboard.mobile.data.local.",
            "app.switchboard.mobile.data.outbox.",
            "app.switchboard.mobile.platform.push.",
        )
        val hits = reached.filter { name -> forbidden.any(name::startsWith) }
        assertEquals(emptyList<String>(), hits)
        assertTrue("the walk reached the rpc", "app.switchboard.mobile.data.remote.PhoneDemoRpc" in reached)
        controller.leave()
        assertNull(runtime.lease("demo"))
    }

    private fun reachableClassNames(root: Any): Set<String> {
        val seen = IdentityHashMap<Any, Boolean>()
        val names = sortedSetOf<String>()
        val queue = ArrayDeque<Any>().apply { add(root) }
        while (queue.isNotEmpty()) {
            val next = queue.removeFirst()
            if (seen.put(next, true) != null) continue
            val type = next.javaClass
            names += type.name
            when (next) {
                is Map<*, *> -> next.entries.forEach { (k, v) -> k?.let(queue::add); v?.let(queue::add) }
                is Iterable<*> -> next.forEach { it?.let(queue::add) }
                is Array<*> -> next.forEach { it?.let(queue::add) }
            }
            if (!type.name.startsWith("app.switchboard.") && !type.name.contains("Lambda")) continue
            var current: Class<*>? = type
            while (current != null && current != Any::class.java) {
                current.declaredFields.filter { !Modifier.isStatic(it.modifiers) && !it.type.isPrimitive }.forEach { field ->
                    runCatching {
                        field.isAccessible = true
                        field.get(next)?.let(queue::add)
                    }
                }
                current = current.superclass
            }
        }
        return names
    }

    private fun emptySnapshot() = app.switchboard.mobile.data.local.OfflineSnapshot(
        connections = emptyList(),
        credentialRefs = emptyList(),
        nativeCredentialRefs = emptyList(),
        preferences = emptyList(),
        threadPreferences = emptyList(),
        collapsedWorkspaces = emptyList(),
        cachedThreads = emptyList(),
        feedRows = emptyList(),
        outbox = emptyList(),
        outboxAttachments = emptyList(),
        replayStates = emptyList(),
        pendingControlActions = emptyList(),
        quarantinedRecords = emptyList(),
    )
}
