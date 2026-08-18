package app.switchboard.mobile.platform.iap

import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CoderResult
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets

sealed interface Utf8NdjsonResult {
    data class Lines(val lines: List<String>) : Utf8NdjsonResult
    data class ProtocolError(val detail: String) : Utf8NdjsonResult
}

class Utf8NdjsonDecoder {
    private val decoder = StandardCharsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
    private var pendingBytes = ByteArray(0)
    private var pendingText = ""
    private var failed = false

    fun push(bytes: ByteArray): Utf8NdjsonResult = decode(bytes, endOfInput = false)

    fun finish(): Utf8NdjsonResult = decode(ByteArray(0), endOfInput = true)

    private fun decode(bytes: ByteArray, endOfInput: Boolean): Utf8NdjsonResult {
        if (failed) return Utf8NdjsonResult.ProtocolError("UTF-8 decoder is closed")
        val inputBytes = pendingBytes + bytes
        val input = ByteBuffer.wrap(inputBytes)
        val output = CharBuffer.allocate(maxOf(4, inputBytes.size * 2 + 2))
        val decoded = decoder.decode(input, output, endOfInput)
        if (decoded.isError) return fail(decoded)
        if (endOfInput) {
            val flushed = decoder.flush(output)
            if (flushed.isError || input.hasRemaining()) return fail(flushed)
            pendingBytes = ByteArray(0)
        } else {
            pendingBytes = ByteArray(input.remaining()).also(input::get)
        }
        output.flip()
        pendingText += output.toString()
        val lines = drainLines()
        if (endOfInput && pendingText.isNotBlank()) return fail("unterminated NDJSON line")
        return Utf8NdjsonResult.Lines(lines)
    }

    private fun drainLines(): List<String> = buildList {
        while (true) {
            val newline = pendingText.indexOf('\n')
            if (newline < 0) return@buildList
            val line = pendingText.substring(0, newline).removeSuffix("\r")
            pendingText = pendingText.substring(newline + 1)
            if (line.isNotBlank()) add(line)
        }
    }

    private fun fail(result: CoderResult): Utf8NdjsonResult.ProtocolError {
        return fail("invalid UTF-8 stream: $result")
    }

    private fun fail(detail: String): Utf8NdjsonResult.ProtocolError {
        failed = true
        pendingBytes = ByteArray(0)
        pendingText = ""
        return Utf8NdjsonResult.ProtocolError(detail)
    }
}
