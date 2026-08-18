package app.switchboard.mobile.data.remote

import app.switchboard.mobile.platform.protocol.AuthenticatedWsCoordinator
import app.switchboard.mobile.platform.protocol.Cancelable
import app.switchboard.mobile.platform.protocol.RequestSubmission
import app.switchboard.mobile.platform.protocol.RpcOutcome
import app.switchboard.mobile.platform.protocol.TransportScope
import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.RuntimeEventPayload

interface RemoteRpc {
    val scope: TransportScope?

    fun invoke(
        expectedScope: TransportScope,
        channel: String,
        args: JsonArray,
        callback: (RpcOutcome) -> Unit,
    ): RequestSubmission

    fun onRuntimeEvent(
        listener: (TransportScope, RuntimeEventPayload) -> Unit,
    ): Cancelable
}

class CoordinatorRemoteRpc(
    private val coordinator: AuthenticatedWsCoordinator,
) : RemoteRpc {
    override val scope: TransportScope?
        get() = coordinator.currentScope

    override fun invoke(
        expectedScope: TransportScope,
        channel: String,
        args: JsonArray,
        callback: (RpcOutcome) -> Unit,
    ): RequestSubmission = coordinator.invoke(expectedScope, channel, args, callback)

    override fun onRuntimeEvent(
        listener: (TransportScope, RuntimeEventPayload) -> Unit,
    ): Cancelable = coordinator.onRuntimeEvent(listener)
}
