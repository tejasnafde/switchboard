package app.switchboard.mobile.platform.notification

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import app.switchboard.mobile.MainActivity

class NotificationTapReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val pending = NotificationTapIntent.decode(intent) ?: return
        val inbox = NotificationRouteInbox(AndroidNotificationRouteStorage(context.applicationContext))
        if (!inbox.offer(pending.tapId, pending.route)) return
        context.startActivity(
            Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_CLEAR_TOP or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP
            },
        )
    }
}
