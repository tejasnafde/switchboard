package app.switchboard.mobile.platform.update

data class DownloadResponsePlan(
    val append: Boolean,
    val startingBytes: Long,
    val totalBytes: Long?,
)

object DownloadResponsePolicy {
    private val contentRangePattern = Regex("bytes\\s+(\\d+)-(\\d+)/(\\d+|\\*)", RegexOption.IGNORE_CASE)

    fun plan(
        statusCode: Int,
        existingBytes: Long,
        contentLength: Long,
        contentRange: String?,
    ): DownloadResponsePlan {
        check(statusCode in 200..299) { "Download failed (HTTP $statusCode)" }
        if (statusCode != 206) {
            return DownloadResponsePlan(
                append = false,
                startingBytes = 0,
                totalBytes = contentLength.takeIf { it >= 0 },
            )
        }

        val match = contentRange?.let(contentRangePattern::matchEntire)
            ?: error("Partial download response omitted Content-Range")
        val responseStart = match.groupValues[1].toLong()
        check(responseStart == existingBytes) { "Partial download resumed at the wrong byte" }
        val declaredTotal = match.groupValues[3].takeUnless { it == "*" }?.toLong()
        val inferredTotal = contentLength.takeIf { it >= 0 }?.plus(existingBytes)
        return DownloadResponsePlan(
            append = existingBytes > 0,
            startingBytes = existingBytes,
            totalBytes = declaredTotal ?: inferredTotal,
        )
    }
}
