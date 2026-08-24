package app.switchboard.mobile.data.remote

import app.switchboard.mobile.data.local.PendingWorktreeCreationDao
import app.switchboard.mobile.data.local.PendingWorktreeCreationEntity
import app.switchboard.mobile.domain.remote.WorktreeCreationRequest
import app.switchboard.mobile.protocol.JsonCodec
import java.util.concurrent.Executor

class RoomWorktreeCreationStore(
    initial: List<PendingWorktreeCreationEntity>,
    private val dao: PendingWorktreeCreationDao,
    private val writes: Executor,
    private val clock: () -> Long = System::currentTimeMillis,
) : NewSessionWorktreeCreationStore {
    private data class Pending(
        val row: PendingWorktreeCreationEntity,
        val request: WorktreeCreationRequest,
    )

    private val pendingByScope = linkedMapOf<Pair<String, String>, Pending>()

    init {
        seed(initial)
    }

    @Synchronized
    fun seed(rows: List<PendingWorktreeCreationEntity>) {
        rows.forEach { row ->
            val request = runCatching {
                WorktreeCreationWire.decodeRequest(JsonCodec.parse(row.requestJson))
            }.getOrNull() ?: return@forEach
            if (
                request.creationId != row.creationId ||
                request.machineId != row.connectionId ||
                request.projectPath != row.projectPath
            ) return@forEach
            val key = row.connectionId to row.projectPath
            val current = pendingByScope[key]
            if (current == null || current.row.updatedAtMs < row.updatedAtMs) {
                pendingByScope[key] = Pending(row, request)
            }
        }
    }

    override fun save(
        creation: WorktreeCreationRequest,
        completion: (Result<Unit>) -> Unit,
    ) {
        val row = entity(creation, clock())
        writes.execute {
            val result = runCatching { dao.upsert(row) }
            if (result.isSuccess) {
                synchronized(this) {
                    pendingByScope[row.connectionId to row.projectPath] = Pending(row, creation)
                }
            }
            completion(result)
        }
    }

    @Synchronized
    override fun load(connectionId: String, projectPath: String): WorktreeCreationRequest? =
        pendingByScope[connectionId to projectPath]?.request

    override fun clear(creationId: String) {
        writes.execute {
            if (runCatching { dao.delete(creationId) }.isSuccess) {
                synchronized(this) {
                    pendingByScope.entries.removeAll { it.value.request.creationId == creationId }
                }
            }
        }
    }

    companion object {
        fun entity(
            request: WorktreeCreationRequest,
            updatedAtMs: Long,
        ) = PendingWorktreeCreationEntity(
            creationId = request.creationId,
            connectionId = request.machineId,
            projectPath = request.projectPath,
            requestJson = JsonCodec.encode(WorktreeCreationWire.encodeRequest(request)),
            updatedAtMs = updatedAtMs,
        )
    }
}
