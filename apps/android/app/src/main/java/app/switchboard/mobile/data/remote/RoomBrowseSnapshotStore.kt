package app.switchboard.mobile.data.remote

import app.switchboard.mobile.data.local.BrowseSnapshotDao
import app.switchboard.mobile.data.local.BrowseSnapshotEntity
import app.switchboard.mobile.domain.remote.Conversation
import app.switchboard.mobile.domain.remote.Project
import app.switchboard.mobile.domain.remote.RemoteDecoders
import app.switchboard.mobile.domain.remote.Workspace
import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonCodec
import java.util.concurrent.Executor

class RoomBrowseSnapshotStore(
    initial: List<BrowseSnapshotEntity>,
    private val dao: BrowseSnapshotDao,
    private val writes: Executor,
    private val clock: () -> Long = System::currentTimeMillis,
) : BrowseSnapshotStore {
    private val rows = linkedMapOf<String, BrowseSnapshotEntity>()

    init {
        seed(initial)
    }

    @Synchronized
    fun seed(snapshotRows: List<BrowseSnapshotEntity>) {
        snapshotRows.forEach { candidate ->
            val current = rows[candidate.snapshotKey]
            if (current == null || current.updatedAtMs < candidate.updatedAtMs) {
                rows[candidate.snapshotKey] = candidate
            }
        }
    }

    @Synchronized
    override fun load(connectionId: String): BrowseSnapshotSeed {
        val matching = rows.values.filter { it.connectionId == connectionId }
        val projects = matching.latest(PROJECTS)?.decode(RemoteDecoders::projects).orEmpty()
        val workspaces = matching.latest(WORKSPACES)?.decode(RemoteDecoders::workspaces).orEmpty()
        val conversations = matching
            .filter { it.kind == CONVERSATIONS && it.projectPath != null }
            .mapNotNull { row ->
                runCatching { row.projectPath!! to RemoteDecoders.conversations(JsonCodec.parse(row.rawJson)) }
                    .getOrNull()
            }
            .toMap()
        return BrowseSnapshotSeed(projects, workspaces, conversations)
    }

    override fun saveProjects(connectionId: String, projects: List<Project>) {
        save(connectionId, PROJECTS, null, projects.map(Project::raw))
    }

    override fun saveWorkspaces(connectionId: String, workspaces: List<Workspace>) {
        save(connectionId, WORKSPACES, null, workspaces.map(Workspace::raw))
    }

    override fun saveConversations(
        connectionId: String,
        projectPath: String,
        conversations: List<Conversation>,
    ) {
        save(connectionId, CONVERSATIONS, projectPath, conversations.map(Conversation::raw))
    }

    private fun save(
        connectionId: String,
        kind: String,
        projectPath: String?,
        values: List<app.switchboard.mobile.protocol.JsonObject>,
    ) {
        val row = BrowseSnapshotEntity(
            snapshotKey = snapshotKey(connectionId, kind, projectPath),
            connectionId = connectionId,
            kind = kind,
            projectPath = projectPath,
            rawJson = JsonCodec.encode(JsonArray(values)),
            updatedAtMs = clock(),
        )
        synchronized(this) { rows[row.snapshotKey] = row }
        writes.execute { dao.upsert(row) }
    }

    private fun <T> BrowseSnapshotEntity.decode(decoder: (app.switchboard.mobile.protocol.JsonValue?) -> List<T>): List<T>? =
        runCatching { decoder(JsonCodec.parse(rawJson)) }.getOrNull()

    private fun List<BrowseSnapshotEntity>.latest(kind: String): BrowseSnapshotEntity? =
        filter { it.kind == kind }.maxByOrNull(BrowseSnapshotEntity::updatedAtMs)

    companion object {
        const val PROJECTS = "projects"
        const val WORKSPACES = "workspaces"
        const val CONVERSATIONS = "conversations"

        fun snapshotKey(connectionId: String, kind: String, projectPath: String?): String =
            JsonCodec.encode(
                JsonArray(
                    listOf(
                        app.switchboard.mobile.protocol.JsonString(connectionId),
                        app.switchboard.mobile.protocol.JsonString(kind),
                        projectPath?.let { app.switchboard.mobile.protocol.JsonString(it) }
                            ?: app.switchboard.mobile.protocol.JsonNull,
                    ),
                ),
            )
    }
}
