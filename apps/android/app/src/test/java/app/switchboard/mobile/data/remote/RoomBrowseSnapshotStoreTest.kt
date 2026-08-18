package app.switchboard.mobile.data.remote

import app.switchboard.mobile.data.local.BrowseSnapshotDao
import app.switchboard.mobile.data.local.BrowseSnapshotEntity
import app.switchboard.mobile.domain.remote.RemoteDecoders
import app.switchboard.mobile.protocol.JsonCodec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RoomBrowseSnapshotStoreTest {
    @Test
    fun loadsExactConnectionRowsAndSkipsMalformedScopesWithoutDiscardingValidCache() {
        val dao = FakeBrowseSnapshotDao()
        val store = RoomBrowseSnapshotStore(
            initial = listOf(
                row("machine", "projects", null, projectsJson("Saved"), 2),
                row("machine", "workspaces", null, workspacesJson("ops"), 2),
                row("machine", "conversations", "/saved", conversationsJson("thread-1"), 2),
                row("machine", "conversations", "/broken", "not-json", 2),
                row("other", "projects", null, projectsJson("Wrong"), 2),
            ),
            dao = dao,
            writes = Runnable::run,
        )

        val seed = store.load("machine")

        assertEquals(listOf("Saved"), seed.projects.map { it.name })
        assertEquals(listOf("ops"), seed.workspaces.map { it.id })
        assertEquals(listOf("thread-1"), seed.conversationsByProject.getValue("/saved").map { it.id })
        assertTrue("/broken" !in seed.conversationsByProject)
    }

    @Test
    fun successfulRemoteValuesReplaceMemoryImmediatelyAndPersistTheExactRawArray() {
        val dao = FakeBrowseSnapshotDao()
        val store = RoomBrowseSnapshotStore(emptyList(), dao, Runnable::run) { 42 }
        val project = RemoteDecoders.projects(JsonCodec.parse(projectsJson("Fresh"))).single()

        store.saveProjects("machine", listOf(project))

        assertEquals("Fresh", store.load("machine").projects.single().name)
        val persisted = dao.rows.single()
        assertEquals("machine", persisted.connectionId)
        assertEquals(42, persisted.updatedAtMs)
        assertEquals(projectsJson("Fresh"), persisted.rawJson)
    }

    @Test
    fun seedingAnOlderStartupSnapshotCannotRollBackANewerInMemoryRefresh() {
        val dao = FakeBrowseSnapshotDao()
        val store = RoomBrowseSnapshotStore(
            listOf(row("machine", "projects", null, projectsJson("Current"), 10)),
            dao,
            Runnable::run,
        )

        store.seed(listOf(row("machine", "projects", null, projectsJson("Stale"), 9)))

        assertEquals("Current", store.load("machine").projects.single().name)
    }

    private fun row(
        connectionId: String,
        kind: String,
        projectPath: String?,
        rawJson: String,
        updatedAt: Long,
    ) = BrowseSnapshotEntity(
        snapshotKey = RoomBrowseSnapshotStore.snapshotKey(connectionId, kind, projectPath),
        connectionId = connectionId,
        kind = kind,
        projectPath = projectPath,
        rawJson = rawJson,
        updatedAtMs = updatedAt,
    )

    private fun projectsJson(name: String) =
        """[{"path":"/$name","name":"$name","sessions":[],"workspaceId":null}]"""

    private fun workspacesJson(id: String) =
        """[{"id":"$id","name":"$id","color":null,"sortOrder":1,"createdAt":1}]"""

    private fun conversationsJson(id: String) =
        """[{"id":"$id","project_path":"/saved","agent_type":"codex","session_id":"$id","title":"$id","created_at":1,"updated_at":2,"worktree_path":null,"worktree_branch":null}]"""
}

private class FakeBrowseSnapshotDao : BrowseSnapshotDao {
    val rows = mutableListOf<BrowseSnapshotEntity>()

    override fun upsert(snapshot: BrowseSnapshotEntity) {
        rows.removeAll { it.snapshotKey == snapshot.snapshotKey }
        rows += snapshot
    }

    override fun forConnection(connectionId: String): List<BrowseSnapshotEntity> =
        rows.filter { it.connectionId == connectionId }

    override fun deleteConnection(connectionId: String) {
        rows.removeAll { it.connectionId == connectionId }
    }
}
