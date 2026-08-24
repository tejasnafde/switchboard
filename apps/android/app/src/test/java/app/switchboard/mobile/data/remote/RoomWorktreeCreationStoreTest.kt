package app.switchboard.mobile.data.remote

import app.switchboard.mobile.data.local.PendingWorktreeCreationDao
import app.switchboard.mobile.data.local.PendingWorktreeCreationEntity
import app.switchboard.mobile.domain.remote.WorktreeCreationOwner
import app.switchboard.mobile.domain.remote.WorktreeCreationRequest
import app.switchboard.mobile.domain.remote.WorktreeLaunchAgent
import app.switchboard.mobile.domain.remote.WorktreeSetupPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RoomWorktreeCreationStoreTest {
    @Test
    fun saveIsDurableBeforeCompletionAndReconstructionRecoversTheExactRequest() {
        val dao = FakePendingWorktreeCreationDao()
        val request = request()
        val first = RoomWorktreeCreationStore(emptyList(), dao, Runnable::run)
        var completion: Result<Unit>? = null

        first.save(request) { completion = it }

        assertTrue(completion?.isSuccess == true)
        assertEquals("creation-1", dao.rows.single().creationId)
        val recreated = RoomWorktreeCreationStore(dao.all(), dao, Runnable::run)
        assertEquals(request, recreated.load("machine", "/repo"))
    }

    @Test
    fun clearRemovesThePendingRequestFromMemoryAndRoom() {
        val dao = FakePendingWorktreeCreationDao()
        val store = RoomWorktreeCreationStore(emptyList(), dao, Runnable::run)
        store.save(request()) {}

        store.clear("creation-1")

        assertNull(store.load("machine", "/repo"))
        assertTrue(dao.rows.isEmpty())
    }

    @Test
    fun malformedPersistedPayloadCannotReplaceAValidPendingRequest() {
        val valid = RoomWorktreeCreationStore.entity(request(), updatedAtMs = 2)
        val malformed = PendingWorktreeCreationEntity(
            creationId = "broken",
            connectionId = "machine",
            projectPath = "/repo",
            requestJson = "not-json",
            updatedAtMs = 3,
        )

        val store = RoomWorktreeCreationStore(
            initial = listOf(valid, malformed),
            dao = FakePendingWorktreeCreationDao(),
            writes = Runnable::run,
        )

        assertEquals(request(), store.load("machine", "/repo"))
    }

    private fun request() = WorktreeCreationRequest(
        creationId = "creation-1",
        machineId = "machine",
        projectPath = "/repo",
        baseRef = "main",
        branchSeed = "thread-1",
        owner = WorktreeCreationOwner.Conversation("thread-1", "claude-code"),
        setupPolicy = WorktreeSetupPolicy.Inherit,
        launchAgent = WorktreeLaunchAgent(
            provider = "claude-code",
            runtimeMode = "sandbox",
            model = null,
            instanceId = "claude-work",
            prompt = "Fix it",
        ),
        requestedAt = 10,
    )
}

private class FakePendingWorktreeCreationDao : PendingWorktreeCreationDao {
    val rows = mutableListOf<PendingWorktreeCreationEntity>()

    override fun upsert(row: PendingWorktreeCreationEntity) {
        rows.removeAll {
            it.creationId == row.creationId ||
                (it.connectionId == row.connectionId && it.projectPath == row.projectPath)
        }
        rows += row
    }

    override fun delete(creationId: String) {
        rows.removeAll { it.creationId == creationId }
    }

    override fun all(): List<PendingWorktreeCreationEntity> = rows.toList()
}
