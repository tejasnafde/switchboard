package app.switchboard.mobile.compat

object LegacySecureStoreKeys {
    const val SHARED_PREFERENCES = "SecureStore"
    const val DEFAULT_KEYCHAIN_SERVICE = "key_v1"

    val GOOGLE_KEYS = listOf(
        "sb.google.refresh_token",
        "sb.google.access_token",
        "sb.google.expires_at",
        "sb.google.email",
        "sb.google.client_id",
        "sb.google.client_secret",
    )

    fun safeConnectionId(connectionId: String): String =
        connectionId.replace(Regex("[^A-Za-z0-9._-]"), "_")

    fun tokenKey(connectionId: String): String = "sb-token-${safeConnectionId(connectionId)}"

    fun sessionKey(connectionId: String): String = "sb-session-${safeConnectionId(connectionId)}"

    fun preferenceKey(logicalKey: String, keychainService: String = DEFAULT_KEYCHAIN_SERVICE): String =
        "$keychainService-$logicalKey"
}
