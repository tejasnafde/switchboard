package app.switchboard.mobile.ui.browse

import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonString

object BrowseCollapsePreferences {
    fun key(connectionId: String): String = "browse.collapsedWorkspaces.$connectionId"

    fun initial(snapshot: OfflineSnapshot, connectionId: String): Set<String> {
        val scoped = snapshot.preferences.firstOrNull { it.key == key(connectionId) }
        if (scoped != null) decode(scoped.value)?.let { return it }
        return snapshot.collapsedWorkspaces.mapTo(linkedSetOf()) { it.workspaceId }
    }

    fun encode(workspaceIds: Set<String>): String = JsonCodec.encode(
        JsonArray(workspaceIds.sorted().map(::JsonString)),
    )

    fun decode(value: String): Set<String>? = runCatching {
        val array = JsonCodec.parse(value) as? JsonArray ?: return null
        array.values.mapTo(linkedSetOf()) {
            (it as? JsonString)?.value ?: error("Expected workspace id string")
        }
    }.getOrNull()
}
