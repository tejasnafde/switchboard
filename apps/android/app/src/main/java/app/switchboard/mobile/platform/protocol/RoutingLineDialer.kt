package app.switchboard.mobile.platform.protocol

class RoutingLineDialer(
    private val directWebSocketDialer: LineDialer,
    private val cloudIapDialer: LineDialer,
) : LineDialer {
    override fun open(
        target: LineTarget,
        callbacks: LineCallbacks,
    ): LineConnection = when (target.endpoint) {
        is LineEndpoint.DirectWebSocket -> directWebSocketDialer.open(target, callbacks)
        is LineEndpoint.CloudIap -> cloudIapDialer.open(target, callbacks)
    }
}
