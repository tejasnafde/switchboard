package app.switchboard.mobile.platform.iap

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets

sealed interface IapRelayFrame {
    data class ConnectSuccess(val sessionId: String) : IapRelayFrame
    data class ReconnectSuccess(val acknowledgedBytes: Long) : IapRelayFrame
    data class Data(val payload: ByteArray) : IapRelayFrame {
        override fun equals(other: Any?): Boolean = other is Data && payload.contentEquals(other.payload)
        override fun hashCode(): Int = payload.contentHashCode()
    }
    data class Ack(val acknowledgedBytes: Long) : IapRelayFrame
}

sealed interface IapRelayParseResult {
    data class Frames(val frames: List<IapRelayFrame>) : IapRelayParseResult
    data class ProtocolError(val detail: String) : IapRelayParseResult
}

object IapRelayCodec {
    const val MAX_DATA_BYTES = 16_384

    fun encodeData(payload: ByteArray): ByteArray {
        require(payload.size <= MAX_DATA_BYTES) { "IAP data frame exceeds $MAX_DATA_BYTES bytes" }
        return ByteBuffer.allocate(HEADER_BYTES + payload.size)
            .order(ByteOrder.BIG_ENDIAN)
            .putShort(DATA_TAG.toShort())
            .putInt(payload.size)
            .put(payload)
            .array()
    }

    fun encodeAck(totalBytes: Long): ByteArray {
        require(totalBytes >= 0) { "IAP acknowledgement must not be negative" }
        return ByteBuffer.allocate(ACK_BYTES)
            .order(ByteOrder.BIG_ENDIAN)
            .putShort(ACK_TAG.toShort())
            .putLong(totalBytes)
            .array()
    }

    fun chunkData(payload: ByteArray): List<ByteArray> {
        if (payload.size <= MAX_DATA_BYTES) return listOf(payload.copyOf())
        return buildList {
            var offset = 0
            while (offset < payload.size) {
                val end = minOf(offset + MAX_DATA_BYTES, payload.size)
                add(payload.copyOfRange(offset, end))
                offset = end
            }
        }
    }

    internal const val CONNECT_SUCCESS_TAG = 0x0001
    internal const val RECONNECT_SUCCESS_TAG = 0x0002
    internal const val DATA_TAG = 0x0004
    internal const val ACK_TAG = 0x0007
    internal const val HEADER_BYTES = 6
    internal const val ACK_BYTES = 10
}

class IapRelayParser {
    private var pending = ByteArray(0)
    private var failed = false

    fun push(chunk: ByteArray): IapRelayParseResult {
        if (failed) return IapRelayParseResult.ProtocolError("IAP relay parser is closed")
        pending += chunk
        val frames = mutableListOf<IapRelayFrame>()
        while (pending.size >= 2) {
            val source = ByteBuffer.wrap(pending).order(ByteOrder.BIG_ENDIAN)
            when (val tag = source.short.toInt() and 0xffff) {
                IapRelayCodec.DATA_TAG,
                IapRelayCodec.CONNECT_SUCCESS_TAG,
                -> {
                    if (pending.size < IapRelayCodec.HEADER_BYTES) break
                    val length = source.int
                    val maximum = if (tag == IapRelayCodec.DATA_TAG) {
                        IapRelayCodec.MAX_DATA_BYTES
                    } else {
                        MAX_SESSION_ID_BYTES
                    }
                    if (length < 0 || length > maximum) return fail("invalid IAP frame length")
                    val frameBytes = IapRelayCodec.HEADER_BYTES + length
                    if (pending.size < frameBytes) break
                    val body = pending.copyOfRange(IapRelayCodec.HEADER_BYTES, frameBytes)
                    val frame = if (tag == IapRelayCodec.DATA_TAG) {
                        IapRelayFrame.Data(body)
                    } else {
                        val sessionId = decodeStrictUtf8(body) ?: return fail("invalid IAP session id")
                        IapRelayFrame.ConnectSuccess(sessionId)
                    }
                    frames += frame
                    pending = pending.copyOfRange(frameBytes, pending.size)
                }

                IapRelayCodec.ACK_TAG,
                IapRelayCodec.RECONNECT_SUCCESS_TAG,
                -> {
                    if (pending.size < IapRelayCodec.ACK_BYTES) break
                    val acknowledged = source.long
                    if (acknowledged < 0) return fail("invalid IAP acknowledgement")
                    frames += if (tag == IapRelayCodec.ACK_TAG) {
                        IapRelayFrame.Ack(acknowledged)
                    } else {
                        IapRelayFrame.ReconnectSuccess(acknowledged)
                    }
                    pending = pending.copyOfRange(IapRelayCodec.ACK_BYTES, pending.size)
                }

                else -> return fail("unknown IAP relay tag 0x${tag.toString(16)}")
            }
        }
        return IapRelayParseResult.Frames(frames)
    }

    private fun fail(detail: String): IapRelayParseResult.ProtocolError {
        failed = true
        pending = ByteArray(0)
        return IapRelayParseResult.ProtocolError(detail)
    }

    private fun decodeStrictUtf8(bytes: ByteArray): String? = try {
        StandardCharsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes))
            .toString()
    } catch (_: Exception) {
        null
    }

    private companion object {
        const val MAX_SESSION_ID_BYTES = 64 * 1024
    }
}
