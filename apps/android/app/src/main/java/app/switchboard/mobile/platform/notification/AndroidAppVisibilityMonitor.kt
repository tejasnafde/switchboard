package app.switchboard.mobile.platform.notification

import android.app.Activity
import android.app.Application
import android.os.Bundle
import java.io.Closeable

class AndroidAppVisibilityMonitor private constructor(
    private val application: Application,
    val tracker: AppVisibilityTracker,
) : Application.ActivityLifecycleCallbacks, Closeable {
    override fun onActivityStarted(activity: Activity) = tracker.activityStarted()

    override fun onActivityStopped(activity: Activity) =
        tracker.activityStopped(activity.isChangingConfigurations)

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
    override fun onActivityResumed(activity: Activity) = Unit
    override fun onActivityPaused(activity: Activity) = Unit
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
    override fun onActivityDestroyed(activity: Activity) = Unit

    override fun close() {
        application.unregisterActivityLifecycleCallbacks(this)
    }

    companion object {
        fun install(
            application: Application,
            tracker: AppVisibilityTracker = AppVisibilityTracker(),
        ): AndroidAppVisibilityMonitor =
            AndroidAppVisibilityMonitor(application, tracker).also {
                application.registerActivityLifecycleCallbacks(it)
            }
    }
}
