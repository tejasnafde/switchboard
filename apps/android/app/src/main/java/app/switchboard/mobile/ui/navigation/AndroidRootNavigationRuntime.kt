package app.switchboard.mobile.ui.navigation

import app.switchboard.mobile.data.connection.ConnectionFleet
import app.switchboard.mobile.data.outbox.OutboxRuntime
import app.switchboard.mobile.data.remote.ReadyClientLease
import app.switchboard.mobile.data.remote.ReadyClientRegistry
import app.switchboard.mobile.domain.connection.ConnectionRuntimeState
import app.switchboard.mobile.domain.outbox.EnqueueResult
import app.switchboard.mobile.domain.outbox.OutgoingTurnDraft
import app.switchboard.mobile.platform.protocol.ProtocolEventHub
import app.switchboard.mobile.platform.protocol.ProtocolHubEvent
import app.switchboard.mobile.platform.protocol.TransportScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow

class AndroidRootNavigationRuntime(
    private val fleet: ConnectionFleet,
    private val clients: ReadyClientRegistry,
    private val outbox: OutboxRuntime,
    private val protocolEvents: ProtocolEventHub,
    private val removeConnection: (String) -> Unit,
) : RootNavigationRuntime {
    override val statuses: StateFlow<Map<String, ConnectionRuntimeState>> = fleet.statuses

    override fun lease(connectionId: String): ReadyClientLease? = clients.lease(connectionId)

    override fun connect(connectionId: String) = fleet.connect(connectionId)

    override fun disconnect(connectionId: String) = fleet.disconnect(connectionId)

    override fun retry(connectionId: String) = fleet.retry(connectionId)

    override fun remove(connectionId: String) {
        removeConnection(connectionId)
    }

    override fun enqueue(draft: OutgoingTurnDraft): EnqueueResult = outbox.enqueue(draft)

    override fun eventsFor(scope: TransportScope): Flow<ProtocolHubEvent> =
        protocolEvents.eventsFor(scope)
}
