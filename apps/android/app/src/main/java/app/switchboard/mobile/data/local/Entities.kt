package app.switchboard.mobile.data.local

import androidx.room.Entity
import androidx.room.Embedded
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.Relation

@Entity(tableName = "connections")
data class ConnectionEntity(
    @androidx.room.PrimaryKey val id: String,
    val label: String,
    val kind: String,
    val url: String?,
    val project: String?,
    val zone: String?,
    val instance: String?,
    val port: Int?,
)

@Entity(
    tableName = "credential_refs",
    foreignKeys = [
        ForeignKey(
            entity = ConnectionEntity::class,
            parentColumns = ["id"],
            childColumns = ["connectionId"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
    indices = [Index("connectionId")],
)
data class CredentialRefEntity(
    @androidx.room.PrimaryKey val connectionId: String,
    val tokenLogicalKey: String,
    val sessionLogicalKey: String,
)

/** Opaque pointer into native encrypted storage; never contains secret bytes. */
@Entity(
    tableName = "native_credential_refs",
    foreignKeys = [
        ForeignKey(
            entity = ConnectionEntity::class,
            parentColumns = ["id"],
            childColumns = ["connectionId"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
    indices = [Index("connectionId")],
)
data class NativeCredentialRefEntity(
    @androidx.room.PrimaryKey val connectionId: String,
    val logicalKey: String,
)

@Entity(tableName = "app_preferences")
data class AppPreferenceEntity(
    @androidx.room.PrimaryKey val key: String,
    val value: String,
)

@Entity(tableName = "thread_preferences")
data class ThreadPreferenceEntity(
    @androidx.room.PrimaryKey val threadKey: String,
    val mode: String?,
    val model: String?,
    val draft: String?,
    val touchedAt: Long,
)

@Entity(tableName = "collapsed_workspaces")
data class CollapsedWorkspaceEntity(
    @androidx.room.PrimaryKey val workspaceId: String,
    val position: Int,
)

@Entity(tableName = "cached_threads")
data class CachedThreadEntity(
    @androidx.room.PrimaryKey val threadKey: String,
    val rawJson: String,
)

@Entity(
    tableName = "cached_feed_rows",
    primaryKeys = ["threadKey", "position"],
    foreignKeys = [
        ForeignKey(
            entity = CachedThreadEntity::class,
            parentColumns = ["threadKey"],
            childColumns = ["threadKey"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
    indices = [Index("threadKey")],
)
data class CachedFeedRowEntity(
    val threadKey: String,
    val itemId: String,
    val position: Int,
    val rawJson: String,
)

@Entity(
    tableName = "outbox",
    indices = [Index("connectionId"), Index("createdAtMs")],
)
data class OutboxEntity(
    @androidx.room.PrimaryKey val origin: String,
    val bubbleId: String,
    val connectionId: String,
    val threadId: String,
    val text: String,
    val runtimeMode: String?,
    val createdAtMs: Long,
    val attempts: Int,
    val nextAttemptAtMs: Long,
    val deliveryState: String,
    val stateReason: String?,
    val receiptLegacy: Boolean?,
    val receiptDuplicate: Boolean?,
    val receiptRawJson: String?,
    val legacyRawJson: String?,
)

@Entity(
    tableName = "outbox_attachments",
    primaryKeys = ["origin", "position"],
    foreignKeys = [
        ForeignKey(
            entity = OutboxEntity::class,
            parentColumns = ["origin"],
            childColumns = ["origin"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
    indices = [Index("origin")],
)
data class OutboxAttachmentEntity(
    val origin: String,
    val position: Int,
    val privatePath: String,
    val mimeType: String?,
)

@Entity(tableName = "replay_state")
data class ReplayStateEntity(
    @androidx.room.PrimaryKey val connectionId: String,
    val epoch: String?,
    val lastSequence: Long,
)

@Entity(
    tableName = "pending_control_actions",
    indices = [Index("connectionId"), Index("status"), Index(value = ["idempotencyKey"], unique = true)],
)
data class PendingControlActionEntity(
    @androidx.room.PrimaryKey val id: String,
    val connectionId: String,
    val channel: String,
    val argsJson: String,
    val requestId: String?,
    val idempotencyKey: String?,
    val createdAt: Long,
    val attempts: Int,
    val status: String,
    val lastError: String?,
)

@Entity(tableName = "migration_checkpoint")
data class MigrationCheckpointEntity(
    @androidx.room.PrimaryKey val id: Int = SINGLETON_ID,
    val sourceFingerprint: String,
    val nativeFingerprint: String,
    val state: String,
) {
    companion object {
        const val SINGLETON_ID = 1
    }
}

@Entity(
    tableName = "quarantined_records",
    primaryKeys = ["sourceKey", "code", "recordKey"],
)
data class QuarantinedRecordEntity(
    val sourceKey: String,
    val code: String,
    val recordKey: String,
    val detail: String,
    val severity: String,
)

data class CachedThreadWithFeed(
    val thread: CachedThreadEntity,
    val feed: List<CachedFeedRowEntity>,
)

data class OutboxWithAttachments(
    @Embedded val message: OutboxEntity,
    @Relation(parentColumn = "origin", entityColumn = "origin")
    val attachments: List<OutboxAttachmentEntity>,
)

data class OfflineSnapshot(
    val connections: List<ConnectionEntity>,
    val credentialRefs: List<CredentialRefEntity>,
    val nativeCredentialRefs: List<NativeCredentialRefEntity>,
    val preferences: List<AppPreferenceEntity>,
    val threadPreferences: List<ThreadPreferenceEntity>,
    val collapsedWorkspaces: List<CollapsedWorkspaceEntity>,
    val cachedThreads: List<CachedThreadEntity>,
    val feedRows: List<CachedFeedRowEntity>,
    val outbox: List<OutboxEntity>,
    val outboxAttachments: List<OutboxAttachmentEntity>,
    val replayStates: List<ReplayStateEntity>,
    val pendingControlActions: List<PendingControlActionEntity>,
    val quarantinedRecords: List<QuarantinedRecordEntity>,
)
