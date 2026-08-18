package app.switchboard.mobile.update

object UpdatePolicy {
    private const val MOBILE_TAG_PREFIX = "mobile-v"
    private const val SHA_256_PREFIX = "sha256:"

    fun isNewer(latest: String, current: String): Boolean {
        val latestSegments = toSegments(latest)
        val currentSegments = toSegments(current)
        val segmentCount = maxOf(latestSegments.size, currentSegments.size)

        for (index in 0 until segmentCount) {
            val latestSegment = latestSegments.getOrElse(index) { 0 }
            val currentSegment = currentSegments.getOrElse(index) { 0 }
            if (latestSegment != currentSegment) return latestSegment > currentSegment
        }
        return false
    }

    fun selectAvailableRelease(
        releases: List<GitHubRelease>,
        currentVersion: String,
    ): UpdateRelease? {
        val candidate = releases.firstNotNullOfOrNull { release ->
            if (release.draft || release.prerelease) return@firstNotNullOfOrNull null

            val tag = release.tagName.trim()
            if (!tag.startsWith(MOBILE_TAG_PREFIX)) return@firstNotNullOfOrNull null

            val version = tag.removePrefix(MOBILE_TAG_PREFIX)
            if (version.isBlank()) return@firstNotNullOfOrNull null

            val apk = release.assets.firstOrNull { asset ->
                asset.name.endsWith(".apk") && asset.downloadUrl.isNotBlank()
            } ?: return@firstNotNullOfOrNull null

            UpdateRelease(
                version = version,
                apkUrl = apk.downloadUrl,
                expectedSha256 = apk.digest?.toSha256(),
            )
        } ?: return null

        return candidate.takeIf { isNewer(it.version, currentVersion) }
    }

    private fun toSegments(version: String): List<Int> = version
        .trim()
        .removePrefix("v")
        .split('.')
        .map { segment ->
            segment.takeWhile(Char::isDigit).toIntOrNull() ?: 0
        }

    private fun String.toSha256(): String? {
        val trimmed = trim()
        if (!trimmed.startsWith(SHA_256_PREFIX, ignoreCase = true)) return null
        return trimmed.substring(SHA_256_PREFIX.length).trim().ifEmpty { null }
    }
}
