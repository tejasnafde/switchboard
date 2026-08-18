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
import kotlinx.coroutines.CoroutineScope
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

        assertEquals(listOf("a"), fixture.factory.created.map { it.connectionId })
        assertEquals(ConnectionStatus.Connecting, fixture.fleet.statuses.value.getValue("a").status)
        assertEquals(ConnectionStatus.Disconnected, fixture.fleet.statuses.value.getValue("iap").status)
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
        assertEquals(0, a.probes)
        assertEquals(listOf(false, true), b.networkStates)
        assertEquals(1, b.probes)
        assertEquals(2, fixture.factory.created.size)
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

    private class Fixture(
        initial: OfflineSnapshot,
        removeResult: ConnectionRemoveResult = ConnectionRemoveResult.Success,
    ) {
        val source = MutableStateFlow<OfflineSnapshot?>(initial)
        val factory = FakeCoordinatorFactory()
        private val scope = CoroutineScope(Job() + Dispatchers.Unconfined)
        val fleet = ConnectionFleet(
            scope = scope,
            snapshots = ConnectionFleetSnapshotSource { source },
            targetResolver = ConnectionFleetTargetResolver { connectionId ->
                ConnectionTargetResolution.Ready(
                    WebSocketTarget(
                        deviceId = "phone",
                        connectionId = connectionId,
                        url = "wss://resolved/$connectionId",
                        credential = Credential.Session("secret"),
                    ),
                )
            },
            coordinatorFactory = factory,
            remover = ConnectionFleetRemover { removeResult },
        )
    }

    private class FakeCoordinatorFactory : ConnectionFleetCoordinatorFactory {
        val created = mutableListOf<FakeCoordinator>()

        override fun create(
            connectionId: String,
            generation: Long,
            onEvent: (ConnectionRuntimeEvent) -> Unit,
        ): ConnectionFleetCoordinator = FakeCoordinator(connectionId, generation, onEvent).also(created::add)

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
        var probes = 0
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

        override fun probe() {
            probes += 1
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

    private fun iap(id: String) = ConnectionSpecFixture(
        ConnectionEntity(id, id, "iap", null, "project", "zone", "vm", 22),
        null,
    )
}
