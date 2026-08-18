package app.switchboard.mobile.platform.notification

data class PendingNotificationRoute(
    val tapId: String,
    val route: NotificationThreadRoute,
)

data class NotificationRouteInboxState(
    val pending: PendingNotificationRoute? = null,
    val consumedTapIds: List<String> = emptyList(),
)

interface NotificationRouteStorage {
    fun read(): NotificationRouteInboxState

    /** A false return means the state was not durably committed. */
    fun write(state: NotificationRouteInboxState): Boolean
}

/**
 * One durable pending route, matching the RN client's latest-pending-route
 * behavior while also surviving Android process recreation.
 */
class NotificationRouteInbox(
    private val storage: NotificationRouteStorage,
) {
    @Synchronized
    fun offer(tapId: String, route: NotificationThreadRoute): Boolean {
        if (tapId.isBlank() || tapId.length > MAX_TAP_ID_LENGTH) return false
        val normalizedRoute = NotificationRouteCodec.normalize(route) ?: return false
        val current = storage.read()
        if (tapId == current.pending?.tapId || tapId in current.consumedTapIds) return false
        return storage.write(current.copy(pending = PendingNotificationRoute(tapId, normalizedRoute)))
    }

    @Synchronized
    fun peek(): PendingNotificationRoute? = storage.read().pending

    @Synchronized
    fun consume(): PendingNotificationRoute? {
        val current = storage.read()
        val pending = current.pending ?: return null
        val consumed = (current.consumedTapIds + pending.tapId).takeLast(MAX_CONSUMED_TAPS)
        return if (storage.write(current.copy(pending = null, consumedTapIds = consumed))) pending else null
    }

    private companion object {
        const val MAX_TAP_ID_LENGTH = 128
        const val MAX_CONSUMED_TAPS = 32
    }
}
