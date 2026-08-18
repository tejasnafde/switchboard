package app.switchboard.mobile.domain.push

import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ExpoPushTokenContractTest {
    private val identity = ExpoPushProjectIdentity(
        projectId = "efbb89d9-210f-4584-bf62-8186cd5fb476",
        applicationId = "app.switchboard.mobile",
    )

    @Test
    fun `request matches Expo getExpoPushToken contract exactly`() {
        val body = JsonCodec.parse(
            ExpoPushTokenContract.requestBody(
                identity = identity,
                installationId = "A0B1C2D3-0000-4000-8000-000000000000",
                fcmToken = "fcm-token",
            ),
        ) as JsonObject

        assertEquals(
            linkedMapOf(
                "type" to JsonString("fcm"),
                "deviceId" to JsonString("a0b1c2d3-0000-4000-8000-000000000000"),
                "development" to JsonBoolean(false),
                "appId" to JsonString("app.switchboard.mobile"),
                "deviceToken" to JsonString("fcm-token"),
                "projectId" to JsonString("efbb89d9-210f-4584-bf62-8186cd5fb476"),
            ),
            body.values,
        )
        assertEquals(
            "https://exp.host/--/api/v2/push/getExpoPushToken",
            ExpoPushTokenContract.ENDPOINT,
        )
    }

    @Test
    fun `successful body requires a valid Expo token`() {
        assertEquals(
            ExpoTokenDecode.Success("ExponentPushToken[existing-device]"),
            ExpoPushTokenContract.decodeResponse(
                """{"data":{"expoPushToken":"ExponentPushToken[existing-device]"}}""",
            ),
        )
        assertEquals(
            ExpoTokenDecode.Success("ExpoPushToken[new-device]"),
            ExpoPushTokenContract.decodeResponse(
                """{"data":{"expoPushToken":"ExpoPushToken[new-device]"}}""",
            ),
        )

        assertTrue(ExpoPushTokenContract.decodeResponse("""{"data":{"error":"denied"}}""") is ExpoTokenDecode.Failure)
        assertTrue(ExpoPushTokenContract.decodeResponse("""{"data":{"expoPushToken":"fcm-token"}}""") is ExpoTokenDecode.Failure)
        assertTrue(ExpoPushTokenContract.decodeResponse("not-json") is ExpoTokenDecode.Failure)
    }
}
