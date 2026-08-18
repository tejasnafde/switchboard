package app.switchboard.mobile.platform.deeplink

import android.content.Intent

object AndroidDeepLinkIntentAdapter {
    fun dataString(intent: Intent?): String? =
        dataString(intent?.action, intent?.dataString)

    fun dataString(action: String?, dataString: String?): String? =
        dataString?.takeIf { action == Intent.ACTION_VIEW && it.isNotBlank() }

    fun classify(intent: Intent?): RegisteredDeepLink =
        dataString(intent)?.let(SwitchboardDeepLinkContract::classify) ?: RegisteredDeepLink.Ignore
}
