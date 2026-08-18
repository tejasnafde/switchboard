package app.switchboard.mobile.platform.push

import android.content.Context
import app.switchboard.mobile.AppContract
import app.switchboard.mobile.BuildConfig
import com.google.firebase.messaging.FirebaseMessaging

object AndroidFirebaseTokenSource {
    fun requestCurrent(context: Context, callback: (String) -> Unit) {
        if (
            !BuildConfig.REMOTE_PUSH_ENABLED ||
            context.applicationContext.packageName != AppContract.RELEASE_APPLICATION_ID
        ) {
            return
        }
        runCatching {
            FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
                if (!task.isSuccessful) return@addOnCompleteListener
                task.result?.takeIf(String::isNotBlank)?.let(callback)
            }
        }
    }
}
