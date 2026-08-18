package app.switchboard.mobile.platform.push

import android.content.Intent
import app.switchboard.mobile.platform.notification.NotificationRouteCodec
import app.switchboard.mobile.platform.notification.NotificationRouteInbox
import app.switchboard.mobile.platform.notification.RemotePushNotificationPolicy
import java.util.UUID

object AndroidRemotePushIntent {
    fun ingest(
        intent: Intent?,
        inbox: NotificationRouteInbox,
        fallbackTapId: () -> String = { UUID.randomUUID().toString() },
    ): Boolean {
        val extras = intent?.extras ?: return false
        val payload = ROUTE_KEYS.mapNotNull { key ->
            extras.getString(key)?.let { key to it }
        }.toMap()
        val pending = RemotePushNotificationPolicy.coldTap(
            payload = payload,
            messageId = extras.getString(FCM_MESSAGE_ID) ?: extras.getString(LEGACY_FCM_MESSAGE_ID),
            fallbackTapId = fallbackTapId(),
        ) ?: return false
        return inbox.offer(pending.tapId, pending.route)
    }

    private const val FCM_MESSAGE_ID = "google.message_id"
    private const val LEGACY_FCM_MESSAGE_ID = "message_id"
    private val ROUTE_KEYS = listOf(
        NotificationRouteCodec.CONNECTION_ID_KEY,
        NotificationRouteCodec.THREAD_ID_KEY,
        NotificationRouteCodec.TITLE_KEY,
        NotificationRouteCodec.PROJECT_PATH_KEY,
        NotificationRouteCodec.CONNECTION_LABEL_KEY,
    )
}
