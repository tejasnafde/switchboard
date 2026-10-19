package app.switchboard.mobile.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DeviceIdentityPayloadTest {
    private val installId = "0b6f3a4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b"

    @Test
    fun `uses the Settings device name and sends every field the backend reads`() {
        val payload = DeviceIdentityPayload.from(
            installId = installId,
            deviceName = " Tejas's Pixel ",
            manufacturer = "Google",
            model = "Pixel 9",
            osVersion = "16",
            appVersion = "0.5.19",
        )

        assertEquals(
            """{"installId":"$installId","name":"Tejas's Pixel","manufacturer":"Google","model":"Pixel 9",""" +
                """"platform":"android","osVersion":"16","appVersion":"0.5.19"}""",
            JsonCodec.encode(payload.toJson()),
        )
    }

    @Test
    fun `falls back to the model when the device name is unreadable or blank`() {
        val unreadable = DeviceIdentityPayload.from(installId, null, "samsung", "SM-S928B", "15", "0.5.19")
        val blank = DeviceIdentityPayload.from(installId, "   ", "samsung", "SM-S928B", "15", "0.5.19")

        assertEquals("SM-S928B", unreadable.name)
        assertEquals("SM-S928B", blank.name)
    }

    @Test
    fun `bounds long display fields and drops empty ones`() {
        val payload = DeviceIdentityPayload.from(installId, "x".repeat(500), "", null, null, "0.5.19")

        assertEquals(DeviceIdentityPayload.MAX_FIELD_LENGTH, payload.name?.length)
        assertNull(payload.manufacturer)
        assertEquals(
            setOf("installId", "name", "platform", "appVersion"),
            payload.toJson().values.keys,
        )
    }

    @Test
    fun `round trips through the auth frame`() {
        val payload = DeviceIdentityPayload.from(installId, "Pixel", "Google", "Pixel 9", "16", "0.5.19")
        val frame = WsFrame.Auth(session = "session-device-7", device = payload)

        assertEquals(frame, WsProtocol.decode(WsProtocol.encode(frame)))
    }
}
