package app.switchboard.mobile.platform.push

import app.switchboard.mobile.data.remote.ReadyClientLease
import app.switchboard.mobile.domain.push.PushBackend
import app.switchboard.mobile.domain.push.PushBackendResult
import app.switchboard.mobile.platform.protocol.TransportScope

class RemoteClientPushBackend(
    private val lease: ReadyClientLease,
) : PushBackend {
    override val scope: TransportScope = lease.scope

    override fun register(
        token: String,
        label: String,
        clientRef: String,
        callback: (PushBackendResult) -> Unit,
    ) {
        lease.client.registerPush(token, label, clientRef, callback)
    }

    override fun unregister(token: String, callback: (PushBackendResult) -> Unit) {
        lease.client.unregisterPush(token, callback)
    }

    override fun reportViewing(
        token: String,
        threadId: String?,
        callback: (PushBackendResult) -> Unit,
    ) {
        lease.client.reportPushViewing(token, threadId, callback)
    }
}
