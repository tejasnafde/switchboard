package app.switchboard.mobile.data.remote

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

    fun onChannelEvent(
        channel: String,
        listener: (TransportScope, JsonArray) -> Unit,
    ): Cancelable = Cancelable {}
}
