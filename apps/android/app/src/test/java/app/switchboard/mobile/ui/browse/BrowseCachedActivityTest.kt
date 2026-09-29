package app.switchboard.mobile.ui.browse

import app.switchboard.mobile.data.local.CachedThreadEntity
import app.switchboard.mobile.data.local.OfflineSnapshot
import org.junit.Assert.assertEquals
import org.junit.Test

class BrowseCachedActivityTest {
    @Test
    fun `a cold start keeps the cached unread count but not the cached status`() {
        val snapshot = OfflineSnapshot(
            connections = emptyList(),
            credentialRefs = emptyList(),
            nativeCredentialRefs = emptyList(),
            preferences = emptyList(),
            threadPreferences = emptyList(),
            collapsedWorkspaces = emptyList(),
            cachedThreads = listOf(
                CachedThreadEntity("mac:chat", """{"status":"running","unread":2}"""),
                CachedThreadEntity("other:chat", """{"status":"running","unread":1}"""),
            ),
            feedRows = emptyList(),
            outbox = emptyList(),
            outboxAttachments = emptyList(),
            replayStates = emptyList(),
            pendingControlActions = emptyList(),
            quarantinedRecords = emptyList(),
        )

        assertEquals(
            mapOf("chat" to BrowseThreadActivity(status = null, unread = 2)),
            BrowseCachedActivity.from(snapshot, "mac"),
        )
    }
}
