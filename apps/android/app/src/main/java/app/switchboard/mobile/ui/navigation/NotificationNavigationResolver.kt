package app.switchboard.mobile.ui.navigation

import app.switchboard.mobile.platform.notification.PendingNotificationRoute
import app.switchboard.mobile.ui.connections.ConnectionsLoadState

object NotificationNavigationResolver {
    fun resolve(
        pending: PendingNotificationRoute,
        connections: ConnectionsLoadState,
        exactLeaseReady: Boolean,
    ): AppRoute.Thread? {
        if (!exactLeaseReady || connections !is ConnectionsLoadState.Ready) return null
        val stored = connections.connections.firstOrNull {
            it.id == pending.route.connectionId
        } ?: return null
        return AppRoute.Thread(
            connectionId = stored.id,
            connectionLabel = stored.label,
            threadId = pending.route.threadId,
            projectPath = pending.route.projectPathHint.orEmpty(),
            title = pending.route.titleHint ?: "Conversation",
        )
    }
}
