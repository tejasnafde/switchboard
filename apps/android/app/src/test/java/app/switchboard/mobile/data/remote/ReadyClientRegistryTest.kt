package app.switchboard.mobile.data.remote

import app.switchboard.mobile.data.connection.ConnectionFleetEndpoint
import app.switchboard.mobile.platform.protocol.Cancelable
import app.switchboard.mobile.platform.protocol.RequestSubmission
import app.switchboard.mobile.platform.protocol.RpcOutcome
import app.switchboard.mobile.platform.protocol.TransportScope
import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.RuntimeEventPayload
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

class ReadyClientRegistryTest {
    @Test
    fun returnsOnlyReadyFleetEndpointsAndReusesTheExactGeneration() {
        var endpoint: ConnectionFleetEndpoint? = null
        val registry = ReadyClientRegistry(ReadyEndpointLookup { endpoint })

        assertNull(registry.lease("a"))

        endpoint = endpoint("a", generation = 3, capabilities = setOf("one"))
        val first = requireNotNull(registry.lease("a"))
        val repeated = requireNotNull(registry.lease("a"))

        assertSame(first.client, repeated.client)
        assertEquals(setOf("one"), first.capabilities)
    }

    @Test
    fun scopeReplacementInvalidatesTheOldClientSynchronously() {
        var endpoint: ConnectionFleetEndpoint? = endpoint("a", 1)
        val registry = ReadyClientRegistry(ReadyEndpointLookup { endpoint })
        val first = requireNotNull(registry.lease("a"))

        endpoint = null
        assertNull(registry.lease("a"))

        endpoint = endpoint("a", 2)
        val second = requireNotNull(registry.lease("a"))
        assertNotSame(first.client, second.client)
        assertEquals(2, second.scope.generation)
    }

    @Test
    fun aReplacementRpcCannotReuseACachedClientEvenIfAProviderRepeatsItsScope() {
        var endpoint: ConnectionFleetEndpoint? = endpoint("a", 1)
        val registry = ReadyClientRegistry(ReadyEndpointLookup { endpoint })
        val first = requireNotNull(registry.lease("a"))

        endpoint = endpoint("a", 1)
        val replacement = requireNotNull(registry.lease("a"))

        assertNotSame(first.client, replacement.client)
    }

    @Test
    fun endpointForAnotherConnectionIsRejected() {
        val registry = ReadyClientRegistry(
            ReadyEndpointLookup { endpoint("other", 1) },
        )

        assertNull(registry.lease("a"))
    }

    private fun endpoint(
        connectionId: String,
        generation: Long,
        capabilities: Set<String> = emptySet(),
    ): ConnectionFleetEndpoint {
        val scope = TransportScope("phone", connectionId, generation)
        return ConnectionFleetEndpoint(scope, capabilities, FakeRemoteRpc(scope))
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
    ): RequestSubmission = error("unused")

    override fun onRuntimeEvent(
        listener: (TransportScope, RuntimeEventPayload) -> Unit,
    ): Cancelable = Cancelable {}
}
