package app.switchboard.mobile.domain.connection

import java.net.URI

/**
 * The backend's TLS certificate pin, carried as `fp` in the pairing URL and in
 * the saved address: SHA-256 of the certificate's DER, 64 lowercase hex chars.
 * Mirrors `src/shared/transport-security.ts`.
 */
object CertificatePin {
    const val QUERY_PARAMETER = "fp"
    private val FINGERPRINT = Regex("^[0-9a-f]{64}$")

    fun isFingerprint(value: String): Boolean = FINGERPRINT.matches(value)

    /** The pin in a saved address, or null when the address has none. */
    fun of(url: String): String? = runCatching { URI(url).rawQuery }.getOrNull().orEmpty()
        .split('&')
        .firstOrNull { it.startsWith("$QUERY_PARAMETER=") }
        ?.substringAfter('=')
        ?.lowercase()
        ?.takeIf(::isFingerprint)
}

/** Release builds dial a remote host only over TLS. */
object CleartextPolicy {
    const val REFUSED_MESSAGE =
        "This build needs an encrypted connection. Update Switchboard on the computer and scan its QR again"

    fun refuses(url: String): Boolean {
        if (!url.startsWith("ws://", ignoreCase = true)) return false
        val host = runCatching { URI(url).host }.getOrNull() ?: return true
        return !isLoopbackHost(host)
    }

    fun isLoopbackHost(host: String): Boolean {
        val h = host.lowercase().removePrefix("[").removeSuffix("]")
        return h == "localhost" || h == "::1" || h == "10.0.2.2" || LOOPBACK_V4.matches(h)
    }

    private val LOOPBACK_V4 = Regex("^127\\.\\d+\\.\\d+\\.\\d+$")
}
