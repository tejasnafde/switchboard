package app.switchboard.mobile.platform.push

import app.switchboard.mobile.domain.push.ExpoPushProjectIdentity
import app.switchboard.mobile.domain.push.ExpoPushTokenContract
import app.switchboard.mobile.domain.push.ExpoTokenDecode
import java.io.IOException
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

class OkHttpExpoTokenExchange(
    private val client: OkHttpClient,
) : ExpoTokenExchange {
    override fun exchange(
        identity: ExpoPushProjectIdentity,
        installationId: String,
        fcmToken: String,
        callback: (ExpoTokenDecode) -> Unit,
    ) {
        val body = ExpoPushTokenContract.requestBody(identity, installationId, fcmToken)
        val request = Request.Builder()
            .url(ExpoPushTokenContract.ENDPOINT)
            .header("accept", "application/json")
            .post(body.toRequestBody(JSON_MEDIA_TYPE))
            .build()
        client.newCall(request).enqueue(
            object : Callback {
                override fun onFailure(call: Call, error: IOException) {
                    callback(ExpoTokenDecode.Failure(error.message ?: "Expo token exchange failed"))
                }

                override fun onResponse(call: Call, response: Response) {
                    response.use {
                        if (!it.isSuccessful) {
                            callback(ExpoTokenDecode.Failure("Expo token exchange returned HTTP ${it.code}"))
                            return
                        }
                        val responseBody = it.body?.string()
                        if (responseBody == null) {
                            callback(ExpoTokenDecode.Failure("Expo token exchange returned an empty body"))
                            return
                        }
                        callback(ExpoPushTokenContract.decodeResponse(responseBody))
                    }
                }
            },
        )
    }

    private companion object {
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
    }
}
