package app.switchboard.mobile.platform.update

import android.content.Context
import android.content.SharedPreferences
import app.switchboard.mobile.update.UpdateState

class SharedPreferencesUpdateStatePersistence(
    context: Context,
) : UpdateStatePersistence {
    private val preferences = context.applicationContext.getSharedPreferences(
        UPDATE_STATE_PREFERENCES,
        Context.MODE_PRIVATE,
    )

    override fun load(): UpdateState? {
        val values = preferences.all.mapNotNull { (key, value) ->
            (value as? String)?.let { key to it }
        }.toMap()
        return if (values.isEmpty()) null else UpdateStateCodec.decode(values)
    }

    override fun save(state: UpdateState) {
        val editor = preferences.edit().clear()
        UpdateStateCodec.encode(state).forEach(editor::putString)
        check(editor.commit()) { "Could not persist updater state" }
    }

    private companion object {
        const val UPDATE_STATE_PREFERENCES = "switchboard_update_state_v1"
    }
}

class SharedPreferencesPendingInstallationPersistence(
    context: Context,
) : PendingInstallationPersistence {
    private val preferences = context.applicationContext.getSharedPreferences(
        PENDING_INSTALLATION_PREFERENCES,
        Context.MODE_PRIVATE,
    )

    override fun load(): PendingInstallation? = try {
        if (!preferences.contains(KEY_PACKAGE_NAME)) return null
        PendingInstallation(
            packageName = preferences.requiredString(KEY_PACKAGE_NAME),
            baselineVersionCode = preferences.getLong(KEY_BASELINE_VERSION_CODE, -1).requireNonNegative(),
            targetVersionCode = preferences.getLong(KEY_TARGET_VERSION_CODE, -1).requireNonNegative(),
            targetVersionName = preferences.requiredString(KEY_TARGET_VERSION_NAME),
            signerSha256 = preferences.requiredString(KEY_SIGNERS).split(',').filter(String::isNotEmpty).toSet(),
            requestedAtEpochMillis = preferences.getLong(KEY_REQUESTED_AT, -1).requireNonNegative(),
        ).takeIf { it.signerSha256.isNotEmpty() }
    } catch (_: RuntimeException) {
        null
    }

    override fun save(pendingInstallation: PendingInstallation) {
        check(
            preferences.edit()
                .clear()
                .putString(KEY_PACKAGE_NAME, pendingInstallation.packageName)
                .putLong(KEY_BASELINE_VERSION_CODE, pendingInstallation.baselineVersionCode)
                .putLong(KEY_TARGET_VERSION_CODE, pendingInstallation.targetVersionCode)
                .putString(KEY_TARGET_VERSION_NAME, pendingInstallation.targetVersionName)
                .putString(KEY_SIGNERS, pendingInstallation.signerSha256.sorted().joinToString(","))
                .putLong(KEY_REQUESTED_AT, pendingInstallation.requestedAtEpochMillis)
                .commit(),
        ) { "Could not persist pending update installation" }
    }

    override fun clear() {
        check(preferences.edit().clear().commit()) { "Could not clear pending update installation" }
    }

    private fun SharedPreferences.requiredString(key: String): String =
        getString(key, null)?.takeIf(String::isNotEmpty) ?: error("Missing pending installation field: $key")

    private fun Long.requireNonNegative(): Long = takeIf { it >= 0 }
        ?: error("Invalid pending installation number")

    private companion object {
        const val PENDING_INSTALLATION_PREFERENCES = "switchboard_pending_installation_v1"
        const val KEY_PACKAGE_NAME = "packageName"
        const val KEY_BASELINE_VERSION_CODE = "baselineVersionCode"
        const val KEY_TARGET_VERSION_CODE = "targetVersionCode"
        const val KEY_TARGET_VERSION_NAME = "targetVersionName"
        const val KEY_SIGNERS = "signers"
        const val KEY_REQUESTED_AT = "requestedAtEpochMillis"
    }
}
