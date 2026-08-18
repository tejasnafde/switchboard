package app.switchboard.mobile.ui.browse

import app.switchboard.mobile.data.local.CachedThreadEntity
import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.domain.remote.Conversation
import app.switchboard.mobile.domain.remote.Project
import app.switchboard.mobile.domain.remote.SessionSummary
import app.switchboard.mobile.protocol.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BrowsePresentationTest {
    @Test
    fun cachedProjectsRemainVisibleDuringInitialRefreshAndFailure() {
        val cached = BrowseProjectRecord(project("/work/switchboard", "Switchboard", "session-1"))
        val loading = BrowsePresenter.projects(BrowseLoadState.Loading(listOf(cached)))
            as BrowseProjectsPresentation.Content
        val failed = BrowsePresenter.projects(
            BrowseLoadState.Failed("Backend not connected yet.", listOf(cached)),
        ) as BrowseProjectsPresentation.Content

        assertEquals(listOf("Switchboard"), loading.rows.map { it.name })
        assertEquals(BrowseStatusKind.CACHED, loading.status.kind)
        assertTrue(loading.status.showProgress)
        assertEquals(listOf("Switchboard"), failed.rows.map { it.name })
        assertEquals(BrowseStatusKind.ERROR, failed.status.kind)
        assertTrue(failed.status.canRetry)
        assertEquals("Backend not connected yet.", failed.status.detail)
    }

    @Test
    fun fullPageStatesOnlyReplaceContentWhenThereIsNoCache() {
        assertEquals(
            BrowseProjectsPresentation.Loading,
            BrowsePresenter.projects(BrowseLoadState.Loading()),
        )
        assertEquals(
            BrowseProjectsPresentation.Empty,
            BrowsePresenter.projects(BrowseLoadState.Ready(emptyList())),
        )
        assertEquals(
            BrowseProjectsPresentation.Failure("Unavailable"),
            BrowsePresenter.projects(BrowseLoadState.Failed("Unavailable")),
        )
        assertEquals(
            BrowseProjectsPresentation.Failure("Refresh failed"),
            BrowsePresenter.projects(
                BrowseLoadState.Ready(emptyList(), recoveryMessage = "Refresh failed"),
            ),
        )
    }

    @Test
    fun cachedProjectCountsNeverIncludeExplicitlyArchivedSessions() {
        val record = BrowseProjectRecord(
            project = project("/work/switchboard", "Switchboard", "visible", "archived"),
            archivedSessionIds = setOf("archived"),
        )

        val content = BrowsePresenter.projects(BrowseLoadState.Ready(listOf(record), cached = true))
            as BrowseProjectsPresentation.Content

        assertEquals(1, content.rows.single().sessionCount)
    }

    @Test
    fun conversationsAreNewestFirstAndArchivedCacheRowsNeverReappear() {
        val snapshot = snapshot(
            CachedThreadEntity("machine-1:visible", "{}"),
            CachedThreadEntity("machine-1:archived", "{}"),
            CachedThreadEntity("machine-10:other", "{}"),
        )
        val index = OfflineBrowseIndex.from(snapshot, connectionId = "machine-1")
        val content = BrowsePresenter.conversations(
            BrowseLoadState.Ready(
                items = listOf(
                    BrowseConversationRecord(conversation("old", 10)),
                    BrowseConversationRecord(conversation("archived", 30), archived = true),
                    BrowseConversationRecord(conversation("visible", 20)),
                ),
                cached = true,
            ),
            offlineIndex = index,
        ) as BrowseConversationsPresentation.Content

        assertEquals(listOf("visible", "old"), content.rows.map { it.id })
        assertTrue(content.rows.first().availableOffline)
        assertFalse(content.rows.last().availableOffline)
        assertFalse(index.contains("other"))
    }

    @Test
    fun archivedOnlyConversationCachePresentsTheRealEmptyState() {
        val result = BrowsePresenter.conversations(
            BrowseLoadState.Ready(
                listOf(BrowseConversationRecord(conversation("archived", 30), archived = true)),
                cached = true,
            ),
            OfflineBrowseIndex.empty(),
        )

        assertEquals(BrowseConversationsPresentation.Empty, result)
    }

    private fun project(path: String, name: String, vararg sessionIds: String) = Project(
        path = path,
        name = name,
        sessions = sessionIds.mapIndexed { index, id ->
            SessionSummary(
                id = id,
                source = "claude",
                title = id,
                startedAt = index.toLong(),
                messageCount = 1,
                filePath = "$path/$id.jsonl",
                raw = emptyJson(),
            )
        },
        workspaceId = null,
        raw = emptyJson(),
    )

    private fun conversation(id: String, updatedAt: Long) = Conversation(
        id = id,
        projectPath = "/work/switchboard",
        agentType = "claude",
        sessionId = id,
        title = id.replaceFirstChar(Char::uppercaseChar),
        createdAt = 1,
        updatedAt = updatedAt,
        worktreePath = null,
        worktreeBranch = null,
        raw = emptyJson(),
    )

    private fun snapshot(vararg threads: CachedThreadEntity) = OfflineSnapshot(
        connections = emptyList(),
        credentialRefs = emptyList(),
        nativeCredentialRefs = emptyList(),
        preferences = emptyList(),
        threadPreferences = emptyList(),
        collapsedWorkspaces = emptyList(),
        cachedThreads = threads.toList(),
        feedRows = emptyList(),
        outbox = emptyList(),
        outboxAttachments = emptyList(),
        replayStates = emptyList(),
        pendingControlActions = emptyList(),
        quarantinedRecords = emptyList(),
    )

    private fun emptyJson() = JsonObject(linkedMapOf())
}
