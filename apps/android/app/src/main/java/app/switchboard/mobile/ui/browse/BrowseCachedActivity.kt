package app.switchboard.mobile.ui.browse

import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject

object BrowseCachedActivity {
    fun from(snapshot: OfflineSnapshot, connectionId: String): Map<String, BrowseThreadActivity> {
        val prefix = "$connectionId:"
        return snapshot.cachedThreads.mapNotNull { cached ->
            if (!cached.threadKey.startsWith(prefix)) return@mapNotNull null
            val raw = runCatching { JsonCodec.parse(cached.rawJson) as? JsonObject }.getOrNull()
                ?: return@mapNotNull null
            // The cached status is left out: it is what the chat last showed, and
            // a turn running then has most likely ended since.
            cached.threadKey.removePrefix(prefix) to BrowseThreadActivity(
                status = null,
                unread = (raw.values["unread"] as? JsonNumber)
                    ?.source
                    ?.toIntOrNull()
                    ?.coerceAtLeast(0)
                    ?: 0,
            )
        }.toMap()
    }
}
