package app.switchboard.mobile.platform.notification

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import app.switchboard.mobile.AppContract
import app.switchboard.mobile.R
import java.util.UUID

class AndroidTurnCompletionNotifier(
    context: Context,
    private val tapIdSource: () -> String = { UUID.randomUUID().toString() },
) : TurnCompletionNotifier {
    private val applicationContext = context.applicationContext

    fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        applicationContext.getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(
                AppContract.NOTIFICATION_CHANNEL_ID,
                AppContract.NOTIFICATION_CHANNEL_NAME,
                NotificationManager.IMPORTANCE_HIGH,
            ),
        )
    }

    override fun post(notification: TurnCompletionNotification): Boolean {
        ensureChannel()
        if (!canPost()) return false
        val tapIntent = NotificationTapIntent.create(
            applicationContext,
            tapIdSource(),
            notification.route,
        )
        val pendingIntent = PendingIntent.getBroadcast(
            applicationContext,
            stableNotificationId(notification.route),
            tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val built = NotificationCompat.Builder(applicationContext, AppContract.NOTIFICATION_CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(notification.title)
            .setContentText(notification.body)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()
        return try {
            NotificationManagerCompat.from(applicationContext).notify(
                stableNotificationId(notification.route),
                built,
            )
            true
        } catch (_: SecurityException) {
            false
        }
    }

    private fun canPost(): Boolean {
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(applicationContext, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return false
        }
        return NotificationManagerCompat.from(applicationContext).areNotificationsEnabled()
    }

    private fun stableNotificationId(route: NotificationThreadRoute): Int {
        var hash = 0x811c9dc5.toInt()
        "${route.connectionId}\u0000${route.threadId}".forEach { character ->
            hash = (hash xor character.code) * 0x01000193
        }
        return hash and Int.MAX_VALUE
    }
}
