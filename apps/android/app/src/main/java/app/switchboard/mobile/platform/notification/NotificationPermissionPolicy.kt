package app.switchboard.mobile.platform.notification

enum class NotificationPermissionDecision {
    Granted,
    Request,
    Denied,
}

object NotificationPermissionPolicy {
    fun decide(
        apiLevel: Int,
        granted: Boolean,
        askedBefore: Boolean,
    ): NotificationPermissionDecision = when {
        apiLevel < ANDROID_13_API -> NotificationPermissionDecision.Granted
        granted -> NotificationPermissionDecision.Granted
        !askedBefore -> NotificationPermissionDecision.Request
        else -> NotificationPermissionDecision.Denied
    }

    private const val ANDROID_13_API = 33
}
