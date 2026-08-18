package app.switchboard.mobile.platform.google

import app.switchboard.mobile.domain.google.GoogleCredentialBundle
import app.switchboard.mobile.domain.google.GoogleRefreshResult
import app.switchboard.mobile.domain.google.GoogleTokenExchange
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import java.util.concurrent.atomic.AtomicBoolean
import okhttp3.Call
import okhttp3.Callback
import okhttp3.FormBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okio.ByteString.Companion.decodeBase64

data class GoogleRefreshHttpRequest(
    val url: String,
    val fields: LinkedHashMap<String, String>,
) {
    override fun toString(): String =
        "GoogleRefreshHttpRequest(url=$url, fields=${fields.keys})"
}

object GoogleTokenHttpContract {
    const val TokenUrl = "https://oauth2.googleapis.com/token"
    private const val MaxResponseBytes = 256L * 1024L

    fun request(credentials: GoogleCredentialBundle): GoogleRefreshHttpRequest {
        val fields = linkedMapOf(
            "client_id" to credentials.clientId,
            "refresh_token" to credentials.refreshToken,
            "grant_type" to "refresh_token",
        )
        credentials.clientSecret?.takeIf(String::isNotBlank)?.let {
            fields["client_secret"] = it
        }
        return GoogleRefreshHttpRequest(TokenUrl, fields)
    }

    fun decode(
        statusCode: Int,
        body: String,
        nowEpochMs: Long,
    ): GoogleRefreshResult {
        val root = runCatching { JsonCodec.parse(body) as? JsonObject }.getOrNull()
        val error = root?.string("error")?.takeIf(String::isNotBlank)
        if (error != null) {
            return GoogleRefreshResult.Failure(error, root.string("error_description"))
        }
        if (statusCode !in 200..299) return GoogleRefreshResult.Failure("http_$statusCode")
        root ?: return GoogleRefreshResult.Failure("invalid_response")
        val accessToken = root.string("access_token")?.takeIf(String::isNotBlank)
            ?: return GoogleRefreshResult.Failure("invalid_response")
        val expiresInSeconds = root.long("expires_in")?.takeIf { it > 0 }
            ?: return GoogleRefreshResult.Failure("invalid_response")
        val expiresAt = runCatching {
            Math.addExact(nowEpochMs, Math.multiplyExact(expiresInSeconds, 1_000L))
        }.getOrNull() ?: return GoogleRefreshResult.Failure("invalid_response")
        return GoogleRefreshResult.Success(
            accessToken = accessToken,
            expiresAtEpochMs = expiresAt,
            email = root.string("id_token")?.let(::emailFromIdToken),
        )
    }

    fun emailFromIdToken(token: String): String? {
        val payload = token.split('.').takeIf { it.size == 3 }?.get(1) ?: return null
        val decoded = payload.decodeBase64()?.utf8() ?: return null
        val root = runCatching { JsonCodec.parse(decoded) as? JsonObject }.getOrNull() ?: return null
        return root.string("email")?.trim()?.takeIf(String::isNotEmpty)
    }

    fun boundedBody(response: Response): String? {
        val body = response.body ?: return null
        if (body.contentLength() > MaxResponseBytes) return null
        val source = body.source()
        val value = source.readUtf8(MaxResponseBytes + 1)
        return value.takeIf { source.exhausted() && it.toByteArray().size <= MaxResponseBytes }
    }

    private fun JsonObject.string(key: String): String? =
        (values[key] as? JsonString)?.value

    private fun JsonObject.long(key: String): Long? =
        (values[key] as? JsonNumber)?.source?.toLongOrNull()
}

class OkHttpGoogleTokenExchange(
    private val client: OkHttpClient,
    private val nowEpochMs: () -> Long,
) : GoogleTokenExchange {
    override fun refresh(
        credentials: GoogleCredentialBundle,
        callback: (GoogleRefreshResult) -> Unit,
    ) {
        val contract = GoogleTokenHttpContract.request(credentials)
        val form = FormBody.Builder().apply {
            contract.fields.forEach { (name, value) -> add(name, value) }
        }.build()
        val request = Request.Builder().url(contract.url).post(form).build()
        val delivered = AtomicBoolean(false)
        fun complete(result: GoogleRefreshResult) {
            if (delivered.compareAndSet(false, true)) callback(result)
        }
        client.newCall(request).enqueue(
            object : Callback {
                override fun onFailure(call: Call, e: java.io.IOException) {
                    complete(GoogleRefreshResult.Failure("network"))
                }

                override fun onResponse(call: Call, response: Response) {
                    response.use {
                        val body = runCatching { GoogleTokenHttpContract.boundedBody(it) }.getOrNull()
                        complete(
                            body?.let { value ->
                                GoogleTokenHttpContract.decode(it.code, value, nowEpochMs())
                            } ?: GoogleRefreshResult.Failure("invalid_response"),
                        )
                    }
                }
            },
        )
    }
}
