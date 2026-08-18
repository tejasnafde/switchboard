package app.switchboard.mobile.ui.browse

import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString

object BrowseCachedActivity {
    fun from(snapshot: OfflineSnapshot, connectionId: String): Map<String, BrowseThreadActivity> {
        val prefix = "$connectionId:"
        return snapshot.cachedThreads.mapNotNull { cached ->
            if (!cached.threadKey.startsWith(prefix)) return@mapNotNull null
            val raw = runCatching { JsonCodec.parse(cached.rawJson) as? JsonObject }.getOrNull()
                ?: return@mapNotNull null
            cached.threadKey.removePrefix(prefix) to BrowseThreadActivity(
                status = (raw.values["status"] as? JsonString)?.value,
                unread = (raw.values["unread"] as? JsonNumber)
                    ?.source
                    ?.toIntOrNull()
                    ?.coerceAtLeast(0)
                    ?: 0,
            )
        }.toMap()
    }
}
