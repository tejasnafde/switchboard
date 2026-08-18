package app.switchboard.mobile.ui.navigation

import app.switchboard.mobile.platform.notification.NotificationThreadRoute
import app.switchboard.mobile.platform.notification.PendingNotificationRoute
import app.switchboard.mobile.ui.connections.ConnectionItem
import app.switchboard.mobile.ui.connections.ConnectionKind
import app.switchboard.mobile.ui.connections.ConnectionStatus
import app.switchboard.mobile.ui.connections.ConnectionTarget
import app.switchboard.mobile.ui.connections.ConnectionsLoadState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NotificationNavigationResolverTest {
    private val pending = PendingNotificationRoute(
        tapId = "tap-1",
        route = NotificationThreadRoute(
            connectionId = "machine-1",
            threadId = "thread-1",
            titleHint = "Build release",
            projectPathHint = "/repo",
            connectionLabelHint = "Untrusted hint",
        ),
    )

    @Test
    fun `tap remains pending until startup target and exact ready lease exist`() {
        assertNull(NotificationNavigationResolver.resolve(pending, ConnectionsLoadState.Loading, false))
        assertNull(NotificationNavigationResolver.resolve(pending, connections(), false))
        assertNull(
            NotificationNavigationResolver.resolve(
                pending.copy(route = pending.route.copy(connectionId = "missing")),
                connections(),
                true,
            ),
        )
    }

    @Test
    fun `accepted tap uses canonical stored label and safe hint fallbacks`() {
        assertEquals(
            AppRoute.Thread(
                connectionId = "machine-1",
                connectionLabel = "Studio Mac",
                threadId = "thread-1",
                projectPath = "/repo",
                title = "Build release",
            ),
            NotificationNavigationResolver.resolve(pending, connections(), true),
        )
        assertEquals(
            AppRoute.Thread(
                connectionId = "machine-1",
                connectionLabel = "Studio Mac",
                threadId = "thread-2",
                projectPath = "",
                title = "Conversation",
            ),
            NotificationNavigationResolver.resolve(
                pending.copy(
                    route = NotificationThreadRoute("machine-1", "thread-2"),
                ),
                connections(),
                true,
            ),
        )
    }

    private fun connections() = ConnectionsLoadState.Ready(
        listOf(
            ConnectionItem(
                id = "machine-1",
                label = "Studio Mac",
                kind = ConnectionKind.WEBSOCKET,
                target = ConnectionTarget.WebSocket("wss://studio"),
                status = ConnectionStatus.LIVE,
            ),
        ),
    )
}
