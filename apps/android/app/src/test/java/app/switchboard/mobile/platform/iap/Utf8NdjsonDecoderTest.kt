package app.switchboard.mobile.platform.iap

import java.nio.charset.StandardCharsets
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class Utf8NdjsonDecoderTest {
    @Test
    fun `split multibyte UTF-8 and partial lines survive relay frame boundaries`() {
        val decoder = Utf8NdjsonDecoder()
        val wire = "{\"text\":\"hi 👋\"}\nnext\n".toByteArray(StandardCharsets.UTF_8)
        val emojiStart = wire.indexOfFirst { it.toInt() and 0xff == 0xf0 }

        assertEquals(
            Utf8NdjsonResult.Lines(emptyList()),
            decoder.push(wire.copyOfRange(0, emojiStart + 2)),
        )
        assertEquals(
            Utf8NdjsonResult.Lines(listOf("{\"text\":\"hi 👋\"}", "next")),
            decoder.push(wire.copyOfRange(emojiStart + 2, wire.size)),
        )
    }

    @Test
    fun `blank lines are skipped while an unterminated line is retained`() {
        val decoder = Utf8NdjsonDecoder()

        assertEquals(
            Utf8NdjsonResult.Lines(listOf("one")),
            decoder.push("\none\npar".toByteArray()),
        )
        assertEquals(
            Utf8NdjsonResult.Lines(listOf("partial")),
            decoder.push("tial\n".toByteArray()),
        )
    }

    @Test
    fun `invalid terminal UTF-8 is a protocol error`() {
        val decoder = Utf8NdjsonDecoder()
        decoder.push(byteArrayOf(0xf0.toByte(), 0x9f.toByte()))

        assertTrue(decoder.finish() is Utf8NdjsonResult.ProtocolError)
    }

    @Test
    fun `unterminated terminal NDJSON is a protocol error`() {
        val decoder = Utf8NdjsonDecoder()
        decoder.push("partial".toByteArray())

        assertEquals(
            Utf8NdjsonResult.ProtocolError("unterminated NDJSON line"),
            decoder.finish(),
        )
    }
}
