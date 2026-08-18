package app.switchboard.mobile.platform.notification

enum class AppVisibilityTransition {
    Foreground,
    Background,
}

/** Tracks process visibility without treating an Activity pause as background. */
class AppVisibilityTracker(
    private val onTransition: (AppVisibilityTransition) -> Unit = {},
) {
    private var startedActivities = 0
    private var foreground = false

    val isForeground: Boolean
        @Synchronized get() = foreground

    fun activityStarted() {
        val changed = synchronized(this) {
            startedActivities += 1
            if (foreground) false else {
                foreground = true
                true
            }
        }
        if (changed) runCatching { onTransition(AppVisibilityTransition.Foreground) }
    }

    fun activityStopped(changingConfigurations: Boolean) {
        val changed = synchronized(this) {
            startedActivities = (startedActivities - 1).coerceAtLeast(0)
            if (startedActivities == 0 && !changingConfigurations && foreground) {
                foreground = false
                true
            } else {
                false
            }
        }
        if (changed) runCatching { onTransition(AppVisibilityTransition.Background) }
    }
}
