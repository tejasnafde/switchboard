package app.switchboard.mobile.platform.protocol

import android.annotation.SuppressLint
import app.switchboard.mobile.domain.connection.ConnectionTerminalReason
import java.io.IOException
import java.security.MessageDigest
import java.security.cert.Certificate
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager
import okhttp3.OkHttpClient

/**
 * Trusts exactly one certificate: the backend's self-signed one, identified by
 * the SHA-256 the pairing QR carried. No CA is consulted and the certificate
 * names no host, so the pin is the whole identity check.
 */
@SuppressLint("CustomX509TrustManager") // Rejects every certificate but the pinned one.
class PinnedCertificateTrustManager(private val fingerprint: String) : X509TrustManager {
    override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
        if (!matchesPin(chain.firstOrNull(), fingerprint)) throw CertificatePinMismatch()
    }

    override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {
        throw CertificateException("client certificates are not accepted")
    }

    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}

class CertificatePinMismatch : CertificateException("the backend certificate does not match the paired fingerprint")

/** The pinned certificate changed: a re-pair is the only fix, so never retry. */
class CertificateChangedFailure(cause: Throwable) :
    IOException("the backend certificate changed", cause),
    NonRetryableTransportFailure {
    override val reason = ConnectionTerminalReason.CertificateChanged
}

fun certificateFingerprint(certificate: Certificate): String =
    MessageDigest.getInstance("SHA-256").digest(certificate.encoded).joinToString("") { "%02x".format(it) }

private fun matchesPin(certificate: Certificate?, fingerprint: String): Boolean =
    certificate != null &&
        MessageDigest.isEqual(certificateFingerprint(certificate).toByteArray(), fingerprint.toByteArray())

/** A client that accepts only the pinned certificate. Shares the pool and dispatcher. */
fun OkHttpClient.pinnedTo(fingerprint: String): OkHttpClient {
    val trust = PinnedCertificateTrustManager(fingerprint)
    val context = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
    return newBuilder()
        .sslSocketFactory(context.socketFactory, trust)
        // The certificate names no host; the hostname check repeats the pin instead.
        .hostnameVerifier { _, session ->
            runCatching { matchesPin(session.peerCertificates.firstOrNull(), fingerprint) }.getOrDefault(false)
        }
        .build()
}

fun Throwable.isCertificatePinMismatch(): Boolean =
    generateSequence(this) { it.cause }.any { it is CertificatePinMismatch }
