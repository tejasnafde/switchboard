package app.switchboard.mobile.platform.push

import android.content.Context

fun androidExpoInstallationIdentity(context: Context): ExpoInstallationIdentity {
    val applicationContext = context.applicationContext
    val legacyPreferences = applicationContext.getSharedPreferences(
        ExpoInstallationIdentity.LEGACY_PREFERENCES_NAME,
        Context.MODE_PRIVATE,
    )
    return ExpoInstallationIdentity(
        noBackupDirectory = applicationContext.noBackupFilesDir,
        legacyPreference = {
            legacyPreferences.getString(ExpoInstallationIdentity.LEGACY_PREFERENCE_KEY, null)
        },
    )
}
