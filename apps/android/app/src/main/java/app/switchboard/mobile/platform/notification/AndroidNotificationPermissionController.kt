package app.switchboard.mobile.platform.notification

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class AndroidNotificationPermissionController(
    context: Context,
) {
    private val applicationContext = context.applicationContext
    private val preferences = applicationContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
    private val notifier = AndroidTurnCompletionNotifier(applicationContext)

    fun requestIfNeeded(activity: Activity): NotificationPermissionDecision {
        notifier.ensureChannel()
        val decision = currentDecision()
        if (decision == NotificationPermissionDecision.Request) {
            preferences.edit().putBoolean(ASKED, true).commit()
            ActivityCompat.requestPermissions(
                activity,
                arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                REQUEST_CODE,
            )
        }
        return decision
    }

    fun currentDecision(): NotificationPermissionDecision = NotificationPermissionPolicy.decide(
        apiLevel = Build.VERSION.SDK_INT,
        granted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(applicationContext, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED,
        askedBefore = preferences.getBoolean(ASKED, false),
    )

    fun openSettings(activity: Activity) {
        activity.startActivity(
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.fromParts("package", activity.packageName, null)
            },
        )
    }

    private companion object {
        const val PREFERENCES_NAME = "native-notification-permission"
        const val ASKED = "asked"
        const val REQUEST_CODE = 5201
    }
}
