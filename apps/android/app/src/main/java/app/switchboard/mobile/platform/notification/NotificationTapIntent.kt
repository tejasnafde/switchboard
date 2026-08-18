package app.switchboard.mobile.platform.notification

import android.content.Context
import android.content.Intent

object NotificationTapIntent {
    const val ACTION = "app.switchboard.mobile.action.OPEN_NOTIFICATION_THREAD"
    private const val TAP_ID_KEY = "app.switchboard.mobile.notification.TAP_ID"
    private const val ROUTE_PREFIX = "app.switchboard.mobile.notification.route."

    fun create(
        context: Context,
        tapId: String,
        route: NotificationThreadRoute,
    ): Intent = Intent(context, NotificationTapReceiver::class.java).apply {
        action = ACTION
        putExtra(TAP_ID_KEY, tapId)
        NotificationRouteCodec.encode(route).forEach { (key, value) ->
            putExtra(ROUTE_PREFIX + key, value)
        }
    }

    fun decode(intent: Intent?): PendingNotificationRoute? {
        if (intent?.action != ACTION) return null
        val tapId = intent.getStringExtra(TAP_ID_KEY)?.takeIf(String::isNotBlank) ?: return null
        val payload = listOf(
            NotificationRouteCodec.CONNECTION_ID_KEY,
            NotificationRouteCodec.THREAD_ID_KEY,
            NotificationRouteCodec.TITLE_KEY,
            NotificationRouteCodec.PROJECT_PATH_KEY,
            NotificationRouteCodec.CONNECTION_LABEL_KEY,
        ).associateWith { intent.getStringExtra(ROUTE_PREFIX + it) }
        val route = NotificationRouteCodec.parse(payload) ?: return null
        return PendingNotificationRoute(tapId, route)
    }
}
