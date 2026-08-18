package app.switchboard.mobile.platform.notification

object RemotePushNotificationPolicy {
    fun completion(payload: Map<String, String>): TurnCompletionNotification? {
        if (payload["kind"] != COMPLETION_KIND) return null
        val route = NotificationRouteCodec.parse(payload) ?: return null
        return TurnCompletionNotification(
            title = DEFAULT_TITLE,
            body = DEFAULT_BODY,
            route = route,
        )
    }

    fun coldTap(
        payload: Map<String, String>,
        messageId: String?,
        fallbackTapId: String,
    ): PendingNotificationRoute? {
        val route = NotificationRouteCodec.parse(payload) ?: return null
        val tapId = messageId
            ?.takeIf { it.isNotBlank() && it.length <= MAX_TAP_ID_LENGTH }
            ?: fallbackTapId.takeIf { it.isNotBlank() && it.length <= MAX_TAP_ID_LENGTH }
            ?: return null
        return PendingNotificationRoute(tapId, route)
    }

    private const val COMPLETION_KIND = "done"
    private const val DEFAULT_TITLE = "Switchboard"
    private const val DEFAULT_BODY = "Done"
    private const val MAX_TAP_ID_LENGTH = 128
}
