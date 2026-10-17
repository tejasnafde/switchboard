package app.switchboard.mobile.domain.connection

import java.net.URI

/**
 * How a saved machine's transport reads on the machine list. Mirrors
 * `src/shared/connection-security.ts`; the strings are in [ConnectionSecurityCopy].
 */
enum class ConnectionSecurity {
    /** wss:// with the QR's certificate pinned. */
    PINNED,

    /** Plain ws:// to loopback or the emulator host. */
    LOCAL,

    /** wss:// to another computer with no certificate pin. */
    ENCRYPTED,

    /** Plain ws:// to another computer, allowed in a debug build. */
    PLAIN,

    /** The Cloud IAP tunnel, encrypted by Google. */
    IAP,

    /** Plain ws:// to another computer that this build will not dial. */
    REFUSED,

    /** The computer answered with another certificate than the pinned one. */
    CERTIFICATE_CHANGED,
}

object ConnectionSecurityPolicy {
    const val SHORT_FINGERPRINT_LENGTH = 8

    /** First 8 lowercase hex of a certificate fingerprint, or null when it is not one. */
    fun shortFingerprint(fingerprint: String?): String? =
        fingerprint?.lowercase()?.takeIf(CertificatePin::isFingerprint)?.take(SHORT_FINGERPRINT_LENGTH)

    fun of(
        url: String?,
        iap: Boolean,
        requireEncryption: Boolean,
        certificateChanged: Boolean,
    ): ConnectionSecurity = when {
        iap -> ConnectionSecurity.IAP
        certificateChanged -> ConnectionSecurity.CERTIFICATE_CHANGED
        url == null -> ConnectionSecurity.PLAIN
        requireEncryption && CleartextPolicy.refuses(url) -> ConnectionSecurity.REFUSED
        CertificatePin.of(url) != null -> ConnectionSecurity.PINNED
        runCatching { URI(url).host }.getOrNull()?.let(CleartextPolicy::isLoopbackHost) == true ->
            ConnectionSecurity.LOCAL
        url.startsWith("wss://", ignoreCase = true) -> ConnectionSecurity.ENCRYPTED
        else -> ConnectionSecurity.PLAIN
    }

    /** Rows listed under "Needs attention": only the user can fix them. */
    fun needsAttention(security: ConnectionSecurity, error: Boolean): Boolean =
        security == ConnectionSecurity.REFUSED || security == ConnectionSecurity.CERTIFICATE_CHANGED || error

    fun showsFingerprint(security: ConnectionSecurity): Boolean =
        security == ConnectionSecurity.PINNED || security == ConnectionSecurity.CERTIFICATE_CHANGED

    fun showsLock(security: ConnectionSecurity): Boolean =
        security == ConnectionSecurity.PINNED ||
            security == ConnectionSecurity.ENCRYPTED ||
            security == ConnectionSecurity.IAP

    fun label(security: ConnectionSecurity): String = when (security) {
        ConnectionSecurity.PINNED, ConnectionSecurity.ENCRYPTED -> ConnectionSecurityCopy.PINNED
        ConnectionSecurity.LOCAL -> ConnectionSecurityCopy.LOCAL
        ConnectionSecurity.PLAIN -> ConnectionSecurityCopy.PLAIN
        ConnectionSecurity.IAP -> ConnectionSecurityCopy.IAP
        ConnectionSecurity.REFUSED -> ConnectionSecurityCopy.REFUSED
        ConnectionSecurity.CERTIFICATE_CHANGED -> ConnectionSecurityCopy.CERTIFICATE_CHANGED
    }
}

/**
 * The phones' transport-security copy, identical to CONNECTION_SECURITY_COPY in
 * `src/shared/connection-security.ts`. ConnectionSecurityTest checks
 * [all] against tests/fixtures/connection-security-copy.json.
 */
object ConnectionSecurityCopy {
    const val SECTION_LIVE = "Live"
    const val SECTION_ATTENTION = "Needs attention"
    const val LIVE_COUNT = "{live} of {total}"
    const val PINNED = "Encrypted"
    const val LOCAL = "Not encrypted, local only"
    const val PLAIN = "Not encrypted"
    const val IAP = "Cloud IAP"
    const val REFUSED = "Needs encryption"
    const val CERTIFICATE_CHANGED = "Certificate changed"
    const val REFUSED_HINT =
        "Not encrypted. This app only connects over an encrypted link. Update Switchboard on that computer " +
            "and scan its new QR, or use Cloud IAP."
    const val SCAN_NEW_QR = "Scan new QR"
    const val USE_CLOUD_IAP = "Use Cloud IAP"
    const val CERTIFICATE_CHANGED_BODY =
        "{label} answered with a certificate that is not the one you paired with. " +
            "Switchboard stopped connecting to it."
    const val CERTIFICATE_EXPECTED_TITLE = "Expected after a reinstall or reset"
    const val CERTIFICATE_EXPECTED_BODY = "Scan its new QR from Settings, Devices & machines on that computer."
    const val CERTIFICATE_UNEXPECTED_TITLE = "Not expected?"
    const val CERTIFICATE_UNEXPECTED_BODY =
        "Someone on this network may be intercepting. Check that screen first: if it still shows " +
            "{fingerprint}, do not scan."
    const val SCAN_QR_AGAIN = "Scan QR again"
    const val REMOVE_MACHINE = "Remove machine"
    const val NOT_NOW = "Not now"

    /** Keyed like the shared object. Android shows only these; the old-QR sheet is iOS only. */
    val all: Map<String, String> = linkedMapOf(
        "sectionLive" to SECTION_LIVE,
        "sectionAttention" to SECTION_ATTENTION,
        "liveCount" to LIVE_COUNT,
        "pinned" to PINNED,
        "local" to LOCAL,
        "plain" to PLAIN,
        "iap" to IAP,
        "refused" to REFUSED,
        "certificateChanged" to CERTIFICATE_CHANGED,
        "refusedHint" to REFUSED_HINT,
        "scanNewQr" to SCAN_NEW_QR,
        "useCloudIap" to USE_CLOUD_IAP,
        "certificateChangedBody" to CERTIFICATE_CHANGED_BODY,
        "certificateExpectedTitle" to CERTIFICATE_EXPECTED_TITLE,
        "certificateExpectedBody" to CERTIFICATE_EXPECTED_BODY,
        "certificateUnexpectedTitle" to CERTIFICATE_UNEXPECTED_TITLE,
        "certificateUnexpectedBody" to CERTIFICATE_UNEXPECTED_BODY,
        "scanQrAgain" to SCAN_QR_AGAIN,
        "removeMachine" to REMOVE_MACHINE,
        "notNow" to NOT_NOW,
    )

    /** A copy string with its `{name}` placeholders filled. */
    fun fill(template: String, vararg values: Pair<String, Any>): String =
        values.fold(template) { text, (name, value) -> text.replace("{$name}", value.toString()) }
}
