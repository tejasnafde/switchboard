package app.switchboard.mobile.platform.push

import android.content.Context
import app.switchboard.mobile.domain.push.ExpoPushTokenContract

class AndroidPushTokenStore(context: Context) : PushTokenStore {
    private val preferences = context.applicationContext.getSharedPreferences(
        PREFERENCES_NAME,
        Context.MODE_PRIVATE,
    )

    override fun read(): PersistedPushToken? {
        val fcmToken = preferences.getString(FCM_TOKEN, null)?.takeIf(String::isNotBlank) ?: return null
        val expoToken = preferences.getString(EXPO_TOKEN, null)
            ?.takeIf(ExpoPushTokenContract::isExpoPushToken)
            ?: return null
        return PersistedPushToken(fcmToken, expoToken)
    }

    override fun write(value: PersistedPushToken): Boolean = preferences.edit()
        .putString(FCM_TOKEN, value.fcmToken)
        .putString(EXPO_TOKEN, value.expoToken)
        .commit()

    private companion object {
        const val PREFERENCES_NAME = "native-push-token"
        const val FCM_TOKEN = "fcm-token"
        const val EXPO_TOKEN = "expo-token"
    }
}
