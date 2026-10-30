package app.switchboard.mobile.data.connection

import app.switchboard.mobile.data.local.ConnectionEntity
import app.switchboard.mobile.data.local.NativeCredentialRefEntity
import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.domain.connection.ConnectionRuntimeEvent
import app.switchboard.mobile.domain.connection.ConnectionStatus
import app.switchboard.mobile.domain.connection.ForegroundAction
import app.switchboard.mobile.data.remote.RemoteRpc
import app.switchboard.mobile.platform.protocol.Cancelable
import app.switchboard.mobile.platform.protocol.RequestSubmission
import app.switchboard.mobile.platform.protocol.RpcFailure
import app.switchboard.mobile.platform.protocol.RpcOutcome
import app.switchboard.mobile.platform.protocol.TransportScope
import app.switchboard.mobile.platform.protocol.WebSocketTarget
import app.switchboard.mobile.protocol.Credential
import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.RuntimeEventPayload
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectionFleetTest {
    @Test
    fun storedConnectionsDoNotDialUntilTheExplicitStartupGateThenEligibleRowsAutoConnect() {
        val fixture = Fixture(snapshot(ws("a"), iap("iap")))

        assertTrue(fixture.factory.created.isEmpty())
        assertTrue(fixture.fleet.statuses.value.isEmpty())

        fixture.fleet.startupReady()

        assertEquals(listOf("a", "iap"), fixture.factory.created.map { it.connectionId })
        assertEquals(ConnectionStatus.Connecting, fixture.fleet.statuses.value.getValue("a").status)
        assertEquals(ConnectionStatus.Connecting, fixture.fleet.statuses.value.getValue("iap").status)
    }

    @Test
    fun `incomplete IAP rows or rows without a backend credential do not auto-connect`() {
        val fixture = Fixture(
            snapshot(
                iap("missing-ref", credentialKey = null),
                iap("missing-project", project = ""),
                iap("bad-port", port = 0),
            ),
        )

        fixture.fleet.startupReady()

        assertTrue(fixture.factory.created.isEmpty())
        assertTrue(fixture.fleet.statuses.value.values.all { it.status == ConnectionStatus.Disconnected })
    }

    @Test
    fun explicitDisconnectSurvivesUnrelatedSnapshotsAndItsOwnEndpointOrCredentialChanges() {
        val fixture = Fixture(snapshot(ws("a"), ws("b"))).also { it.fleet.startupReady() }
        val originalA = fixture.factory.latest("a")
        val originalB = fixture.factory.latest("b")

        fixture.fleet.disconnect("a")
        fixture.source.value = snapshot(
            ws("a", url = "wss://new-a", credentialKey = "new-ref"),
            ws("b", label = "renamed only"),
        )

        assertTrue(originalA.destroyed)
        assertEquals(1, fixture.factory.created.count { it.connectionId == "a" })
        assertFalse(originalB.destroyed)
        assertEquals(ConnectionStatus.Disconnected, fixture.fleet.statuses.value.getValue("a").status)
    }

    @Test
    fun endpointAndCredentialChangesRebuildOnlyTheAffectedConnectedCoordinator() {
        val fixture = Fixture(snapshot(ws("a"), ws("b"))).also { it.fleet.startupReady() }
        val firstA = fixture.factory.latest("a")
        val firstB = fixture.factory.latest("b")

        fixture.source.value = snapshot(ws("a", url = "wss://changed"), ws("b"))

        assertTrue(firstA.destroyed)
        assertFalse(firstB.destroyed)
        assertEquals(2, fixture.factory.created.count { it.connectionId == "a" })
        assertEquals(1, fixture.factory.created.count { it.connectionId == "b" })

        val secondA = fixture.factory.latest("a")
        fixture.source.value = snapshot(ws("a", url = "wss://changed", credentialKey = "rotated"), ws("b"))

        assertTrue(secondA.destroyed)
        assertEquals(3, fixture.factory.created.count { it.connectionId == "a" })
        assertFalse(firstB.destroyed)
    }

    @Test
    fun staleCallbacksFromReplacedGenerationsCannotOverwriteCurrentStatus() {
        val fixture = Fixture(snapshot(ws("a"))).also { it.fleet.startupReady() }
        val old = fixture.factory.latest("a")

        fixture.fleet.retry("a")
        val current = fixture.factory.latest("a")
        current.emit(ConnectionRuntimeEvent.Ready(current.generation))
        old.emit(ConnectionRuntimeEvent.Stopped(old.generation, authenticationRejected = true))

        assertEquals(ConnectionStatus.Connected, fixture.fleet.statuses.value.getValue("a").status)
        assertEquals(current.generation, fixture.fleet.statuses.value.getValue("a").generation)
    }

    @Test
    fun connectIsAbsoluteAndIdempotentWhileRetryAlwaysRebuilds() {
        val fixture = Fixture(snapshot(ws("a"))).also { it.fleet.startupReady() }
        val first = fixture.factory.latest("a")

        fixture.fleet.connect("a")
        fixture.fleet.connect("a")
        assertEquals(1, fixture.factory.created.size)

        fixture.fleet.retry("a")
        assertTrue(first.destroyed)
        assertEquals(2, fixture.factory.created.size)
    }

    @Test
    fun endpointExistsOnlyForTheExactReadyCoordinatorGenerationAndInvalidatesSynchronously() {
        val fixture = Fixture(snapshot(ws("a"))).also { it.fleet.startupReady() }
        val first = fixture.factory.latest("a")
        assertEquals(null, fixture.fleet.endpoint("a"))
        first.becomeReady(setOf("durable_turn_origin"))

        val ready = fixture.fleet.endpoint("a")
        assertEquals(first.transportScope, ready?.scope)
        assertEquals(setOf("durable_turn_origin"), ready?.capabilities)

        fixture.fleet.retry("a")
        assertEquals(null, fixture.fleet.endpoint("a"))
        first.emit(ConnectionRuntimeEvent.Ready(first.generation))
        assertEquals(null, fixture.fleet.endpoint("a"))

        val second = fixture.factory.latest("a")
        second.becomeReady(emptySet())
        assertEquals(second.transportScope, fixture.fleet.endpoint("a")?.scope)
        fixture.fleet.disconnect("a")
        assertEquals(null, fixture.fleet.endpoint("a"))
    }

    @Test
    fun removeFailureIsVisibleAndKeepsTheStillStoredRowExplicitlyDisconnected() = runBlocking {
        val fixture = Fixture(snapshot(ws("a")), removeResult = ConnectionRemoveResult.Failure("db busy"))
            .also { it.fleet.startupReady() }
        val first = fixture.factory.latest("a")

        val result = fixture.fleet.remove("a")
        fixture.source.value = snapshot(ws("a", label = "still here"))

        assertEquals(ConnectionRemoveResult.Failure("db busy"), result)
        assertTrue(first.destroyed)
        assertEquals(ConnectionStatus.Error, fixture.fleet.statuses.value.getValue("a").status)
        assertTrue(fixture.fleet.statuses.value.getValue("a").detail.contains("db busy"))
        assertEquals(1, fixture.factory.created.size)
    }

    @Test
    fun removedRowsAndCloseDestroyCoordinatorsAndIgnoreLaterSnapshots() = runBlocking {
        val fixture = Fixture(snapshot(ws("a"), ws("b"))).also { it.fleet.startupReady() }
        val a = fixture.factory.latest("a")
        val b = fixture.factory.latest("b")

        fixture.source.value = snapshot(ws("b"))
        assertTrue(a.destroyed)
        assertFalse(fixture.fleet.statuses.value.containsKey("a"))

        fixture.fleet.close()
        fixture.source.value = snapshot(ws("b"), ws("c"))

        assertTrue(b.destroyed)
        assertTrue(fixture.fleet.statuses.value.isEmpty())
        assertFalse(fixture.factory.created.any { it.connectionId == "c" })
    }

    @Test
    fun `launch offline parks initial desired connections until network returns`() {
        val fixture = Fixture(snapshot(ws("a")))

        fixture.fleet.onNetworkChanged(available = false)
        fixture.fleet.startupReady()

        val coordinator = fixture.factory.latest("a")
        assertEquals(listOf(false), coordinator.networkStates)
        assertEquals(listOf("network:false", "connect"), coordinator.calls)

        fixture.fleet.onNetworkChanged(available = true)
        assertEquals(listOf(false, true), coordinator.networkStates)
    }

    @Test
    fun `network regain and foreground actions never revive explicit disconnects`() {
        val fixture = Fixture(snapshot(ws("a"), ws("b"))).also { it.fleet.startupReady() }
        val a = fixture.factory.latest("a")
        val b = fixture.factory.latest("b")
        fixture.fleet.disconnect("a")

        fixture.fleet.onNetworkChanged(available = false)
        fixture.fleet.onNetworkChanged(available = true)
        fixture.fleet.onForeground(ForegroundAction.Probe)

        assertTrue(a.networkStates.isEmpty())
        assertEquals(0, a.resumes)
        assertEquals(listOf(false, true), b.networkStates)
        // Once for the network return, once for the foreground probe.
        assertEquals(2, b.resumes)
        assertEquals(2, fixture.factory.created.size)
    }

    @Test
    fun `network route change checks every desired connection and skips explicit disconnects`() {
        val fixture = Fixture(snapshot(ws("a"), ws("b"))).also { it.fleet.startupReady() }
        val a = fixture.factory.latest("a")
        val b = fixture.factory.latest("b")
        fixture.fleet.disconnect("a")

        fixture.fleet.onNetworkRouteChanged()

        assertEquals(0, a.resumes)
        assertEquals(1, b.resumes)
        assertEquals(2, fixture.factory.created.size)
    }

    @Test
    fun `short foreground return restarts a connection whose start failed`() {
        var failing = true
        val fixture = Fixture(snapshot(ws("a")), failCreate = { failing }).also { it.fleet.startupReady() }
        assertTrue(fixture.factory.created.isEmpty())
        assertEquals(ConnectionStatus.Error, fixture.fleet.statuses.value.getValue("a").status)

        failing = false
        fixture.fleet.onForeground(ForegroundAction.Probe)

        assertEquals(1, fixture.factory.created.size)
        assertEquals(ConnectionStatus.Connecting, fixture.fleet.statuses.value.getValue("a").status)
    }

    @Test
    fun `long foreground absence rebuilds only desired connections`() {
        val fixture = Fixture(snapshot(ws("a"), ws("b"))).also { it.fleet.startupReady() }
        val firstA = fixture.factory.latest("a")
        val firstB = fixture.factory.latest("b")
        fixture.fleet.disconnect("a")

        fixture.fleet.onForeground(ForegroundAction.Reconnect)

        assertTrue(firstA.destroyed)
        assertTrue(firstB.destroyed)
        assertEquals(1, fixture.factory.created.count { it.connectionId == "a" })
        assertEquals(2, fixture.factory.created.count { it.connectionId == "b" })
    }

    /**
     * The 2026-10-30 report: back from the background after 10 s or more, every
     * screen stayed on "The saved machine could not be opened" until a relaunch.
     * The foreground callback runs on the main thread, and the reconnect read
     * the stored machine there; Room refuses main-thread reads.
     */
    @Test
    fun `a foreground reconnect reads the stored machine off the calling thread`() {
        val caller = Thread.currentThread()
        val executor = Executors.newSingleThreadExecutor()
        try {
            val fixture = Fixture(
                snapshot(ws("a")),
                dispatcher = executor.asCoroutineDispatcher(),
                resolve = { connectionId ->
                    check(Thread.currentThread() !== caller) { "Cannot access database on the main thread" }
                    readyTarget(connectionId)
                },
            )
            fixture.fleet.startupReady()
            fixture.awaitStatus("a", ConnectionStatus.Connecting)
            runBlocking { withTimeout(5_000) { while (fixture.factory.created.isEmpty()) kotlinx.coroutines.delay(10) } }
            val first = fixture.factory.latest("a")

            fixture.fleet.onForeground(ForegroundAction.Reconnect)

            runBlocking { withTimeout(5_000) { while (fixture.factory.created.size < 2) kotlinx.coroutines.delay(10) } }
            assertTrue(first.destroyed)
            assertEquals(ConnectionStatus.Connecting, fixture.status("a"))
            assertEquals(listOf("connect"), fixture.factory.latest("a").calls)

            fixture.fleet.retry("a")
            runBlocking { withTimeout(5_000) { while (fixture.factory.created.size < 3) kotlinx.coroutines.delay(10) } }
            assertEquals(ConnectionStatus.Connecting, fixture.status("a"))
            fixture.fleet.close()
        } finally {
            executor.shutdownNow()
        }
    }

    @Test
    fun `a retryable resolve failure is tried again on its own`() {
        var failures = 2
        val fixture = Fixture(
            snapshot(ws("a")),
            resolveRetryDelayMs = { 0L },
            resolve = { connectionId ->
                if (failures-- > 0) {
                    ConnectionTargetResolution.Failure("The saved machine could not be opened", retryable = true)
                } else {
                    readyTarget(connectionId)
                }
            },
        )

        fixture.fleet.startupReady()

        assertEquals(3, fixture.resolveCalls.get())
        assertEquals(1, fixture.factory.created.size)
        assertEquals(ConnectionStatus.Connecting, fixture.status("a"))
    }

    @Test
    fun `a network return or a short foreground return retries a failed resolve at once`() {
        var failing = true
        val fixture = Fixture(
            snapshot(ws("a"), ws("b")),
            resolve = { connectionId ->
                if (failing) {
                    ConnectionTargetResolution.Failure("The saved credential could not be read", retryable = true)
                } else {
                    readyTarget(connectionId)
                }
            },
        )
        fixture.fleet.onNetworkChanged(available = true)
        fixture.fleet.startupReady()
        assertEquals(ConnectionStatus.Error, fixture.status("a"))
        assertTrue(fixture.factory.created.isEmpty())

        failing = false
        fixture.fleet.onNetworkChanged(available = false)
        assertTrue(fixture.factory.created.isEmpty())
        fixture.fleet.onNetworkChanged(available = true)
        assertEquals(listOf("a", "b"), fixture.factory.created.map { it.connectionId })

        failing = true
        fixture.fleet.retry("b")
        assertEquals(ConnectionStatus.Error, fixture.status("b"))
        failing = false
        fixture.fleet.onForeground(ForegroundAction.Probe)
        assertEquals(ConnectionStatus.Connecting, fixture.status("b"))
        assertEquals(3, fixture.factory.created.size)
    }

    @Test
    fun `timer retries of a resolve failure stop after a limit`() {
        val fixture = Fixture(
            snapshot(ws("a")),
            resolveRetryDelayMs = { 0L },
            resolve = { ConnectionTargetResolution.Failure("The saved credential could not be read", retryable = true) },
        )

        fixture.fleet.startupReady()

        assertEquals(9, fixture.resolveCalls.get())
        assertEquals(ConnectionStatus.Error, fixture.status("a"))
    }

    @Test
    fun `a terminal resolve failure is not retried by a timer`() {
        val fixture = Fixture(
            snapshot(ws("a")),
            resolveRetryDelayMs = { 0L },
            resolve = { ConnectionTargetResolution.Failure("That machine no longer exists") },
        )

        fixture.fleet.startupReady()

        assertEquals(1, fixture.resolveCalls.get())
        assertEquals(ConnectionStatus.Error, fixture.status("a"))
    }

    @Test
    fun `a resolve that finishes after a newer start is dropped`() {
        val pending = mutableListOf<() -> Unit>()
        val queued = object : CoroutineDispatcher() {
            override fun dispatch(context: kotlin.coroutines.CoroutineContext, block: Runnable) {
                pending += { block.run() }
            }
        }
        val fixture = Fixture(snapshot(ws("a")), dispatcher = queued)
        fixture.fleet.startupReady()
        pending.removeAt(0)()
        fixture.fleet.retry("a")
        fixture.fleet.retry("a")

        pending.toList().also { pending.clear() }.forEach { it() }

        assertEquals(1, fixture.factory.created.size)
        assertEquals(fixture.fleet.statuses.value.getValue("a").generation, fixture.factory.latest("a").generation)
    }

    /**
     * Doze or a backend restart while in the background: the socket dies and
     * the coordinator stops or waits out a backoff. A short return checks it,
     * and the next Ready names a new transport scope, which every screen keys on.
     */
    @Test
    fun `a socket lost in the background is checked on return and its new scope replaces the old one`() {
        val fixture = Fixture(snapshot(ws("a"))).also { it.fleet.startupReady() }
        val first = fixture.factory.latest("a")
        first.becomeReady(emptySet())
        val before = fixture.fleet.endpoint("a")?.scope

        first.emit(ConnectionRuntimeEvent.Retrying(first.generation, attempt = 1, closeCode = 1012))
        assertEquals(null, fixture.fleet.endpoint("a"))
        fixture.fleet.onForeground(ForegroundAction.Probe)
        assertEquals(1, first.resumes)

        fixture.fleet.onForeground(ForegroundAction.Reconnect)
        val second = fixture.factory.latest("a")
        second.becomeReady(emptySet())
        val after = fixture.fleet.endpoint("a")?.scope
        assertTrue(after != null && after != before)
    }

    private class Fixture(
        initial: OfflineSnapshot,
        removeResult: ConnectionRemoveResult = ConnectionRemoveResult.Success,
        failCreate: () -> Boolean = { false },
        dispatcher: CoroutineDispatcher = Dispatchers.Unconfined,
        resolveRetryDelayMs: (Int) -> Long = { 60_000L },
        resolve: (String) -> ConnectionTargetResolution = ::readyTarget,
    ) {
        val source = MutableStateFlow<OfflineSnapshot?>(initial)
        val factory = FakeCoordinatorFactory(failCreate)
        val resolveCalls = AtomicInteger()
        private val scope = CoroutineScope(Job() + dispatcher)
        val fleet = ConnectionFleet(
            scope = scope,
            snapshots = ConnectionFleetSnapshotSource { source },
            targetResolver = ConnectionFleetTargetResolver { connectionId ->
                resolveCalls.incrementAndGet()
                resolve(connectionId)
            },
            coordinatorFactory = factory,
            remover = ConnectionFleetRemover { removeResult },
            resolveRetryDelayMs = resolveRetryDelayMs,
        )

        fun status(connectionId: String): ConnectionStatus = fleet.statuses.value.getValue(connectionId).status

        fun awaitStatus(connectionId: String, status: ConnectionStatus) = runBlocking {
            withTimeout(5_000) { fleet.statuses.first { it[connectionId]?.status == status } }
        }
    }

    private class FakeCoordinatorFactory(
        private val failCreate: () -> Boolean,
    ) : ConnectionFleetCoordinatorFactory {
        val created: MutableList<FakeCoordinator> = CopyOnWriteArrayList()

        override fun create(
            connectionId: String,
            generation: Long,
            onEvent: (ConnectionRuntimeEvent) -> Unit,
        ): ConnectionFleetCoordinator {
            if (failCreate()) throw IllegalStateException("keystore locked")
            return FakeCoordinator(connectionId, generation, onEvent).also(created::add)
        }

        fun latest(connectionId: String): FakeCoordinator = created.last { it.connectionId == connectionId }
    }

    private class FakeCoordinator(
        val connectionId: String,
        val generation: Long,
        private val onEvent: (ConnectionRuntimeEvent) -> Unit,
    ) : ConnectionFleetCoordinator {
        val transportScope = TransportScope("phone", connectionId, generation + 100)
        private val rpc = FakeRemoteRpc(transportScope)
        override var endpoint: ConnectionFleetEndpoint? = null
        val targets = mutableListOf<WebSocketTarget>()
        val calls = mutableListOf<String>()
        val networkStates = mutableListOf<Boolean>()
        var resumes = 0
        var disconnected = false
        var destroyed = false

        override fun connect(target: WebSocketTarget) {
            calls += "connect"
            targets += target
        }

        override fun setNetworkAvailable(available: Boolean) {
            calls += "network:$available"
            networkStates += available
        }

        override fun resume() {
            resumes += 1
        }

        override fun disconnect() {
            disconnected = true
        }

        override fun destroy() {
            destroyed = true
        }

        fun emit(event: ConnectionRuntimeEvent) = onEvent(event)

        fun becomeReady(capabilities: Set<String>) {
            endpoint = ConnectionFleetEndpoint(transportScope, capabilities, rpc)
            emit(ConnectionRuntimeEvent.Ready(generation))
        }
    }

    private class FakeRemoteRpc(
        override val scope: TransportScope?,
    ) : RemoteRpc {
        override fun invoke(
            expectedScope: TransportScope,
            channel: String,
            args: JsonArray,
            callback: (RpcOutcome) -> Unit,
        ): RequestSubmission = RequestSubmission.Rejected(RpcFailure.NotReady)

        override fun onRuntimeEvent(
            listener: (TransportScope, RuntimeEventPayload) -> Unit,
        ): Cancelable = Cancelable {}
    }

    private companion object {
        fun readyTarget(connectionId: String): ConnectionTargetResolution = ConnectionTargetResolution.Ready(
            WebSocketTarget(
                deviceId = "phone",
                connectionId = connectionId,
                url = "wss://resolved/$connectionId",
                credential = Credential.Session("secret"),
            ),
        )
    }

    private fun snapshot(vararg rows: ConnectionSpecFixture): OfflineSnapshot = OfflineSnapshot(
        connections = rows.map(ConnectionSpecFixture::entity),
        credentialRefs = emptyList(),
        nativeCredentialRefs = rows.mapNotNull { row ->
            row.credentialKey?.let { NativeCredentialRefEntity(row.entity.id, it) }
        },
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

    private data class ConnectionSpecFixture(
        val entity: ConnectionEntity,
        val credentialKey: String?,
    )

    private fun ws(
        id: String,
        url: String = "wss://$id",
        label: String = id,
        credentialKey: String? = "ref-$id",
    ) = ConnectionSpecFixture(
        ConnectionEntity(id, label, "ws", url, null, null, null, null),
        credentialKey,
    )

    private fun iap(
        id: String,
        project: String = "project",
        port: Int = 8766,
        credentialKey: String? = "ref-$id",
    ) = ConnectionSpecFixture(
        ConnectionEntity(id, id, "iap", null, project, "zone", "vm", port),
        credentialKey,
    )
}
