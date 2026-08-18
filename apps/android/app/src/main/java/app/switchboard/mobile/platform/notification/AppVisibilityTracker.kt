package app.switchboard.mobile.platform.notification

/** Tracks process visibility without treating an Activity pause as background. */
class AppVisibilityTracker {
    private var startedActivities = 0
    private var foreground = false

    val isForeground: Boolean
        @Synchronized get() = foreground

    @Synchronized
    fun activityStarted() {
        startedActivities += 1
        foreground = true
    }

    @Synchronized
    fun activityStopped(changingConfigurations: Boolean) {
        startedActivities = (startedActivities - 1).coerceAtLeast(0)
        if (startedActivities == 0 && !changingConfigurations) foreground = false
    }
}
