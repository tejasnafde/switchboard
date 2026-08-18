package app.switchboard.mobile.platform.iap

import java.nio.charset.StandardCharsets

enum class LineQueueOffer { Queued, Full }

class BoundedLineQueue(
    private val maxLines: Int,
    private val maxUtf8Bytes: Int,
) {
    private val lines = ArrayDeque<String>()
    private var utf8Bytes = 0

    init {
        require(maxLines > 0)
        require(maxUtf8Bytes > 0)
    }

    fun offer(line: String): LineQueueOffer {
        val size = line.toByteArray(StandardCharsets.UTF_8).size
        if (lines.size >= maxLines || size > maxUtf8Bytes - utf8Bytes) return LineQueueOffer.Full
        lines += line
        utf8Bytes += size
        return LineQueueOffer.Queued
    }

    fun drain(): List<String> {
        val drained = lines.toList()
        clear()
        return drained
    }

    fun clear() {
        lines.clear()
        utf8Bytes = 0
    }
}
