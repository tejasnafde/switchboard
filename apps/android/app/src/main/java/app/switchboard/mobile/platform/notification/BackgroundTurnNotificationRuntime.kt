package app.switchboard.mobile.platform.notification

import app.switchboard.mobile.platform.protocol.ProtocolEventHub
import app.switchboard.mobile.platform.protocol.ProtocolHubEvent
import java.io.Closeable
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch

/** Process-alive bridge from the scoped protocol hub to notification policy. */
class BackgroundTurnNotificationRuntime(
    private val scope: CoroutineScope,
    private val events: ProtocolEventHub,
    private val coordinator: BackgroundTurnNotificationCoordinator,
) : Closeable {
    private var observation: Job? = null

    @Synchronized
    fun start() {
        if (observation != null) return
        observation = scope.launch {
            events.events.collect { event ->
                if (event is ProtocolHubEvent.Runtime) {
                    coordinator.onRuntimeEvent(event.scope, event.event)
                }
            }
        }
    }

    @Synchronized
    override fun close() {
        observation?.cancel()
        observation = null
    }
}
