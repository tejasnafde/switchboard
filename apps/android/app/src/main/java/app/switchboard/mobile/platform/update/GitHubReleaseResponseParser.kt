package app.switchboard.mobile.platform.update

import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.update.GitHubAsset
import app.switchboard.mobile.update.GitHubRelease

object GitHubReleaseResponseParser {
    fun parse(body: String): List<GitHubRelease> {
        val root = JsonCodec.parse(body) as? JsonArray
            ?: throw IllegalArgumentException("GitHub releases response was not a list")
        return root.values.mapIndexed { index, value ->
            val release = value as? JsonObject
                ?: throw IllegalArgumentException("GitHub release at index $index was not an object")
            GitHubRelease(
                tagName = release.string("tag_name"),
                draft = release.boolean("draft"),
                prerelease = release.boolean("prerelease"),
                assets = release.array("assets").mapIndexed { assetIndex, assetValue ->
                    val asset = assetValue as? JsonObject
                        ?: throw IllegalArgumentException(
                            "GitHub release asset at index $index:$assetIndex was not an object",
                        )
                    GitHubAsset(
                        name = asset.string("name"),
                        downloadUrl = asset.string("browser_download_url"),
                        digest = (asset.values["digest"] as? JsonString)?.value,
                    )
                },
            )
        }
    }

    private fun JsonObject.string(key: String): String = (values[key] as? JsonString)?.value.orEmpty()

    private fun JsonObject.boolean(key: String): Boolean = (values[key] as? JsonBoolean)?.value ?: false

    private fun JsonObject.array(key: String) = (values[key] as? JsonArray)?.values.orEmpty()
}
