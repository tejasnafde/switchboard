package app.switchboard.mobile.platform.google

import app.switchboard.mobile.compat.LegacySecureStoreKeys
import app.switchboard.mobile.domain.google.GoogleCredentialBundle
import app.switchboard.mobile.platform.migration.LegacySecretReader
import app.switchboard.mobile.platform.migration.LegacySecureValue
import app.switchboard.mobile.platform.storage.NativeCredentialPlatform

interface GoogleMigrationCheckpointStore {
    val complete: Boolean

    fun markComplete(): Boolean
}

class PreferenceGoogleMigrationCheckpointStore(
    private val platform: NativeCredentialPlatform,
) : GoogleMigrationCheckpointStore {
    override val complete: Boolean
        get() = try {
            platform.readPreference(PREFERENCE_FILE, COMPLETE_KEY) == COMPLETE_VALUE
        } catch (_: Exception) {
            false
        }

    override fun markComplete(): Boolean = try {
        platform.writePreference(PREFERENCE_FILE, COMPLETE_KEY, COMPLETE_VALUE)
    } catch (_: Exception) {
        false
    }

    companion object {
        const val PREFERENCE_FILE = "SwitchboardNativeGoogleMigration"
        const val COMPLETE_KEY = "legacy_google_import_v1"
        const val COMPLETE_VALUE = "complete"
    }
}

sealed interface GoogleLegacyMigrationResult {
    data object Migrated : GoogleLegacyMigrationResult
    data object AlreadyComplete : GoogleLegacyMigrationResult
    data object ExistingNative : GoogleLegacyMigrationResult
    data object NothingToMigrate : GoogleLegacyMigrationResult
    data class Blocked(val reason: String) : GoogleLegacyMigrationResult
}

class GoogleLegacyCredentialMigrator(
    private val legacy: LegacySecretReader,
    private val native: GoogleNativeCredentialStore,
    private val checkpoint: GoogleMigrationCheckpointStore,
) {
    fun migrate(): GoogleLegacyMigrationResult {
        if (checkpoint.complete) return GoogleLegacyMigrationResult.AlreadyComplete
        when (native.readStatus()) {
            GoogleCredentialReadResult.Absent -> Unit
            is GoogleCredentialReadResult.Blocked ->
                return GoogleLegacyMigrationResult.Blocked("Native Google credential state is unreadable")
            is GoogleCredentialReadResult.Available -> {
                return if (checkpoint.markComplete()) {
                    GoogleLegacyMigrationResult.ExistingNative
                } else {
                    GoogleLegacyMigrationResult.Blocked("Google migration checkpoint commit failed")
                }
            }
        }

        val values = LegacySecureStoreKeys.GOOGLE_KEYS.associateWith(legacy::read)
        if (values.values.any { it is LegacySecureValue.Failure }) {
            return GoogleLegacyMigrationResult.Blocked("A legacy Google credential could not be read")
        }
        if (values.values.all { it == LegacySecureValue.Missing }) {
            return finishWithoutCredentials()
        }
        val clientId = values.found(CLIENT_ID)
        val refreshToken = values.found(REFRESH_TOKEN)
        if (clientId == null || refreshToken == null) {
            return GoogleLegacyMigrationResult.Blocked("Legacy Google identity is incomplete")
        }
        val expiresAt = when (val expiry = values[EXPIRES_AT]) {
            is LegacySecureValue.Found -> expiry.value.trim().toLongOrNull()?.takeIf { it > 0 }
                ?: return GoogleLegacyMigrationResult.Blocked("Legacy Google expiry is invalid")
            LegacySecureValue.Missing -> null
            is LegacySecureValue.Failure -> error("legacy failures were handled before parsing")
            null -> error("canonical legacy key inventory is incomplete")
        }

        val credentials = GoogleCredentialBundle(
            clientId = clientId,
            clientSecret = values.found(CLIENT_SECRET),
            refreshToken = refreshToken,
            accessToken = values.found(ACCESS_TOKEN),
            expiresAtEpochMs = expiresAt,
            email = values.found(EMAIL),
        )
        return when (native.writeAndVerify(credentials)) {
            GoogleCredentialWriteResult.Verified -> if (checkpoint.markComplete()) {
                GoogleLegacyMigrationResult.Migrated
            } else {
                GoogleLegacyMigrationResult.Blocked("Google migration checkpoint commit failed")
            }

            is GoogleCredentialWriteResult.Failed ->
                GoogleLegacyMigrationResult.Blocked("Native Google credential verification failed")
        }
    }

    private fun finishWithoutCredentials(): GoogleLegacyMigrationResult =
        if (checkpoint.markComplete()) {
            GoogleLegacyMigrationResult.NothingToMigrate
        } else {
            GoogleLegacyMigrationResult.Blocked("Google migration checkpoint commit failed")
        }

    private fun Map<String, LegacySecureValue>.found(key: String): String? =
        (get(key) as? LegacySecureValue.Found)?.value?.trim()?.takeIf(String::isNotEmpty)

    private companion object {
        const val REFRESH_TOKEN = "sb.google.refresh_token"
        const val ACCESS_TOKEN = "sb.google.access_token"
        const val EXPIRES_AT = "sb.google.expires_at"
        const val EMAIL = "sb.google.email"
        const val CLIENT_ID = "sb.google.client_id"
        const val CLIENT_SECRET = "sb.google.client_secret"
    }
}
