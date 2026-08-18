package app.switchboard.mobile.platform.google

import app.switchboard.mobile.domain.google.GoogleCredentialBundle
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import java.util.concurrent.atomic.AtomicBoolean
import okhttp3.Call
import okhttp3.Callback
import okhttp3.FormBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response

class GoogleRevokeHttpRequest internal constructor(
    val url: String,
    private val token: String,
) {
    internal fun formFields(): LinkedHashMap<String, String> = linkedMapOf("token" to token)

    override fun toString(): String = "GoogleRevokeHttpRequest(url=$url, token=[REDACTED])"
}

sealed interface GoogleRemoteRevokeResult {
    data object Revoked : GoogleRemoteRevokeResult
    data object Skipped : GoogleRemoteRevokeResult
    data object NetworkFailure : GoogleRemoteRevokeResult
    data class HttpFailure(val statusCode: Int) : GoogleRemoteRevokeResult
    data object Rejected : GoogleRemoteRevokeResult
    data object InvalidResponse : GoogleRemoteRevokeResult
}

object GoogleRevokeHttpContract {
    const val RevokeUrl = "https://oauth2.googleapis.com/revoke"

    fun request(credentials: GoogleCredentialBundle): GoogleRevokeHttpRequest? {
        val token = credentials.refreshToken.trim().takeIf(String::isNotEmpty)
            ?: credentials.accessToken?.trim()?.takeIf(String::isNotEmpty)
            ?: return null
        return GoogleRevokeHttpRequest(RevokeUrl, token)
    }

    fun decode(statusCode: Int, body: String): GoogleRemoteRevokeResult {
        if (body.isBlank()) {
            return if (statusCode in 200..299) {
                GoogleRemoteRevokeResult.Revoked
            } else {
                GoogleRemoteRevokeResult.HttpFailure(statusCode)
            }
        }
        val root = runCatching { JsonCodec.parse(body) as? JsonObject }.getOrNull()
            ?: return if (statusCode in 200..299) {
                GoogleRemoteRevokeResult.InvalidResponse
            } else {
                GoogleRemoteRevokeResult.HttpFailure(statusCode)
            }
        if ((root.values["error"] as? JsonString)?.value?.isNotBlank() == true) {
            return GoogleRemoteRevokeResult.Rejected
        }
        return if (statusCode in 200..299) {
            GoogleRemoteRevokeResult.InvalidResponse
        } else {
            GoogleRemoteRevokeResult.HttpFailure(statusCode)
        }
    }
}

fun interface GoogleRevokeTransport {
    fun revoke(
        request: GoogleRevokeHttpRequest,
        callback: (GoogleRemoteRevokeResult) -> Unit,
    )
}

class OkHttpGoogleRevokeTransport(
    private val client: OkHttpClient,
) : GoogleRevokeTransport {
    override fun revoke(
        request: GoogleRevokeHttpRequest,
        callback: (GoogleRemoteRevokeResult) -> Unit,
    ) {
        val form = FormBody.Builder().apply {
            request.formFields().forEach { (name, value) -> add(name, value) }
        }.build()
        val httpRequest = Request.Builder().url(request.url).post(form).build()
        val delivered = AtomicBoolean(false)
        fun complete(result: GoogleRemoteRevokeResult) {
            if (delivered.compareAndSet(false, true)) callback(result)
        }
        client.newCall(httpRequest).enqueue(
            object : Callback {
                override fun onFailure(call: Call, e: java.io.IOException) {
                    complete(GoogleRemoteRevokeResult.NetworkFailure)
                }

                override fun onResponse(call: Call, response: Response) {
                    response.use {
                        val body = runCatching { boundedBody(it) }.getOrNull()
                        complete(
                            body?.let { value -> GoogleRevokeHttpContract.decode(it.code, value) }
                                ?: GoogleRemoteRevokeResult.InvalidResponse,
                        )
                    }
                }
            },
        )
    }

    private fun boundedBody(response: Response): String? {
        val body = response.body ?: return ""
        if (body.contentLength() > MaxResponseBytes) return null
        val source = body.source()
        val value = source.readUtf8(MaxResponseBytes + 1)
        return value.takeIf { source.exhausted() && it.toByteArray().size <= MaxResponseBytes }
    }

    private companion object {
        const val MaxResponseBytes = 256L * 1024L
    }
}
