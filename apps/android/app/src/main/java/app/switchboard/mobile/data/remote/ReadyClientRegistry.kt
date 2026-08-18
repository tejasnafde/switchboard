package app.switchboard.mobile.data.remote

import app.switchboard.mobile.data.connection.ConnectionFleetEndpoint
import app.switchboard.mobile.platform.protocol.TransportScope

fun interface ReadyEndpointLookup {
    fun endpoint(connectionId: String): ConnectionFleetEndpoint?
}

data class ReadyClientLease(
    val scope: TransportScope,
    val capabilities: Set<String>,
    val client: SwitchboardRemoteClient,
)

class ReadyClientRegistry(
    private val endpoints: ReadyEndpointLookup,
) {
    private data class CachedLease(
        val rpc: RemoteRpc,
        val lease: ReadyClientLease,
    )

    private val leases = mutableMapOf<String, CachedLease>()

    @Synchronized
    fun lease(connectionId: String): ReadyClientLease? {
        val endpoint = endpoints.endpoint(connectionId)
        if (
            endpoint == null ||
            endpoint.scope.connectionId != connectionId ||
            endpoint.rpc.scope != endpoint.scope
        ) {
            leases.remove(connectionId)
            return null
        }
        val existing = leases[connectionId]
        if (existing?.lease?.scope == endpoint.scope && existing.rpc === endpoint.rpc) {
            return existing.lease.copy(capabilities = endpoint.capabilities).also {
                leases[connectionId] = CachedLease(endpoint.rpc, it)
            }
        }
        return ReadyClientLease(
            scope = endpoint.scope,
            capabilities = endpoint.capabilities,
            client = SwitchboardRemoteClient(connectionId, endpoint.rpc),
        ).also { leases[connectionId] = CachedLease(endpoint.rpc, it) }
    }

    @Synchronized
    fun invalidate(connectionId: String) {
        leases.remove(connectionId)
    }

    @Synchronized
    fun clear() {
        leases.clear()
    }
}
