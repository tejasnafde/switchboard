package app.switchboard.mobile.ui.browse

import app.switchboard.mobile.data.local.AppPreferenceEntity
import app.switchboard.mobile.data.local.CollapsedWorkspaceEntity
import app.switchboard.mobile.data.local.OfflineSnapshot
import org.junit.Assert.assertEquals
import org.junit.Test

class BrowseCollapsePreferencesTest {
    @Test
    fun connectionScopedValueWinsAndAnExplicitEmptyListDoesNotReseedLegacyRows() {
        val snapshot = snapshot(
            preferences = listOf(
                AppPreferenceEntity(BrowseCollapsePreferences.key("a"), "[]"),
                AppPreferenceEntity(BrowseCollapsePreferences.key("b"), "[\"b-only\"]"),
            ),
            legacy = listOf(CollapsedWorkspaceEntity("legacy", 0)),
        )

        assertEquals(emptySet<String>(), BrowseCollapsePreferences.initial(snapshot, "a"))
        assertEquals(setOf("b-only"), BrowseCollapsePreferences.initial(snapshot, "b"))
        assertEquals(setOf("legacy"), BrowseCollapsePreferences.initial(snapshot, "c"))
    }

    @Test
    fun codecIsDeterministicAndSafeForArbitraryWorkspaceIds() {
        val encoded = BrowseCollapsePreferences.encode(setOf("z", "quotes\\\"and/slash", "a"))

        assertEquals(setOf("a", "quotes\\\"and/slash", "z"), BrowseCollapsePreferences.decode(encoded))
    }

    private fun snapshot(
        preferences: List<AppPreferenceEntity>,
        legacy: List<CollapsedWorkspaceEntity>,
    ) = OfflineSnapshot(
        connections = emptyList(),
        credentialRefs = emptyList(),
        nativeCredentialRefs = emptyList(),
        preferences = preferences,
        threadPreferences = emptyList(),
        collapsedWorkspaces = legacy,
        cachedThreads = emptyList(),
        feedRows = emptyList(),
        outbox = emptyList(),
        outboxAttachments = emptyList(),
        replayStates = emptyList(),
        pendingControlActions = emptyList(),
        quarantinedRecords = emptyList(),
    )
}
