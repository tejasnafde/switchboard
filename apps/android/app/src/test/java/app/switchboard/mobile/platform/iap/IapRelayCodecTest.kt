package app.switchboard.mobile.platform.iap

import java.nio.charset.StandardCharsets
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class IapRelayCodecTest {
    @Test
    fun `data and ack encoding use canonical tags and big-endian fields`() {
        assertArrayEquals(
            byteArrayOf(0x00, 0x04, 0x00, 0x00, 0x00, 0x03, 0x61, 0x62, 0x63),
            IapRelayCodec.encodeData("abc".toByteArray(StandardCharsets.UTF_8)),
        )
        assertArrayEquals(
            byteArrayOf(0x00, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80.toByte(), 0x00),
            IapRelayCodec.encodeAck(32_768),
        )
    }

    @Test
    fun `payloads are split at the exact relay limit`() {
        val chunks = IapRelayCodec.chunkData(ByteArray(16_385) { (it % 127).toByte() })

        assertEquals(listOf(16_384, 1), chunks.map(ByteArray::size))
    }

    @Test
    fun `incremental parser carries a connect frame across websocket messages`() {
        val parser = IapRelayParser()
        val frame = lengthPrefixed(tag = 0x0001, body = "sid-7".toByteArray())

        assertEquals(IapRelayParseResult.Frames(emptyList()), parser.push(frame.copyOfRange(0, 4)))
        assertEquals(
            IapRelayParseResult.Frames(listOf(IapRelayFrame.ConnectSuccess("sid-7"))),
            parser.push(frame.copyOfRange(4, frame.size)),
        )
    }

    @Test
    fun `unknown tag makes the stream unparseable instead of consuming arbitrary bytes`() {
        val result = IapRelayParser().push(byteArrayOf(0x12, 0x34, 0x55, 0x66))

        assertTrue(result is IapRelayParseResult.ProtocolError)
    }

    private fun lengthPrefixed(tag: Int, body: ByteArray): ByteArray = byteArrayOf(
        (tag ushr 8).toByte(),
        tag.toByte(),
        0,
        0,
        0,
        body.size.toByte(),
        *body,
    )
}
