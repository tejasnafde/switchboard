package app.switchboard.mobile.platform.push

import app.switchboard.mobile.SwitchboardApplication
import app.switchboard.mobile.platform.notification.AndroidTurnCompletionNotifier
import app.switchboard.mobile.platform.notification.RemotePushNotificationPolicy
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class SwitchboardFirebaseMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        super.onNewToken(token)
        (application as? SwitchboardApplication)?.onFcmToken(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        super.onMessageReceived(message)
        val notification = RemotePushNotificationPolicy.completion(message.data) ?: return
        AndroidTurnCompletionNotifier(applicationContext).post(notification)
    }
}
