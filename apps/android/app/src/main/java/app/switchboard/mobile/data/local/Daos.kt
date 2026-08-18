package app.switchboard.mobile.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import androidx.room.Update
import androidx.room.Upsert

@Dao
abstract class ConnectionDao {
    @Upsert
    abstract fun upsert(connection: ConnectionEntity)

    @Upsert
    abstract fun upsertCredentialRefs(refs: CredentialRefEntity)

    @Upsert
    protected abstract fun upsertNativeCredentialRef(ref: NativeCredentialRefEntity)

    @Transaction
    open fun upsertWithNativeCredential(
        connection: ConnectionEntity,
        ref: NativeCredentialRefEntity,
    ) {
        upsert(connection)
        upsertNativeCredentialRef(ref)
    }

    @Query("DELETE FROM connections WHERE id = :connectionId")
    abstract fun delete(connectionId: String): Int

    @Query("SELECT * FROM connections WHERE id = :id")
    abstract fun find(id: String): ConnectionEntity?

    @Query("SELECT * FROM credential_refs WHERE connectionId = :connectionId")
    abstract fun findCredentialRefs(connectionId: String): CredentialRefEntity?

    @Query("SELECT * FROM native_credential_refs WHERE connectionId = :connectionId")
    abstract fun findNativeCredentialRef(connectionId: String): NativeCredentialRefEntity?

    @Query(
        "UPDATE native_credential_refs SET logicalKey = :newRef " +
            "WHERE connectionId = :connectionId AND logicalKey = :expectedOldRef",
    )
    abstract fun compareAndSwapNativeCredentialRef(
        connectionId: String,
        expectedOldRef: String,
        newRef: String,
    ): Int

    @Query("SELECT * FROM connections ORDER BY id")
    abstract fun all(): List<ConnectionEntity>

    @Query("SELECT * FROM credential_refs ORDER BY connectionId")
    abstract fun allCredentialRefs(): List<CredentialRefEntity>
}

@Dao
abstract class PreferenceDao {
    @Upsert
    abstract fun upsertPreference(preference: AppPreferenceEntity)

    @Upsert
    abstract fun upsertThreadPreference(preference: ThreadPreferenceEntity)

    @Upsert
    protected abstract fun insertCollapsedWorkspaces(rows: List<CollapsedWorkspaceEntity>)

    @Query("DELETE FROM collapsed_workspaces")
    protected abstract fun clearCollapsedWorkspaces()

    @Transaction
    open fun replaceCollapsedWorkspaces(rows: List<CollapsedWorkspaceEntity>) {
        clearCollapsedWorkspaces()
        insertCollapsedWorkspaces(rows)
    }

    @Query("SELECT * FROM app_preferences WHERE `key` = :key")
    abstract fun findPreference(key: String): AppPreferenceEntity?

    @Query("SELECT * FROM thread_preferences WHERE threadKey = :threadKey")
    abstract fun findThreadPreference(threadKey: String): ThreadPreferenceEntity?

    @Query("SELECT * FROM app_preferences ORDER BY `key`")
    abstract fun allPreferences(): List<AppPreferenceEntity>

    @Query("SELECT * FROM thread_preferences ORDER BY threadKey")
    abstract fun allThreadPreferences(): List<ThreadPreferenceEntity>

    @Query("SELECT * FROM collapsed_workspaces ORDER BY position, workspaceId")
    abstract fun allCollapsedWorkspaces(): List<CollapsedWorkspaceEntity>
}

@Dao
abstract class CacheDao {
    @Upsert
    abstract fun upsertThread(thread: CachedThreadEntity)

    @Upsert
    protected abstract fun insertFeedRows(rows: List<CachedFeedRowEntity>)

    @Query("DELETE FROM cached_feed_rows WHERE threadKey = :threadKey")
    protected abstract fun clearFeedRows(threadKey: String)

    @Transaction
    open fun replaceFeedRows(threadKey: String, rows: List<CachedFeedRowEntity>) {
        clearFeedRows(threadKey)
        insertFeedRows(rows)
    }

    @Query("SELECT * FROM cached_threads WHERE threadKey = :threadKey")
    abstract fun findThread(threadKey: String): CachedThreadEntity?

    @Query("SELECT * FROM cached_feed_rows WHERE threadKey = :threadKey ORDER BY position, itemId")
    abstract fun feedRows(threadKey: String): List<CachedFeedRowEntity>

    @Query("SELECT * FROM cached_threads ORDER BY threadKey")
    abstract fun allThreads(): List<CachedThreadEntity>

    @Query("SELECT * FROM cached_feed_rows ORDER BY threadKey, position, itemId")
    abstract fun allFeedRows(): List<CachedFeedRowEntity>
}

@Dao
interface OutboxDao {
    @Insert(onConflict = OnConflictStrategy.ABORT)
    fun insertMessage(message: OutboxEntity): Long

    @Insert(onConflict = OnConflictStrategy.ABORT)
    fun insertAttachments(rows: List<OutboxAttachmentEntity>)

    @Transaction
    fun insert(message: OutboxEntity, rows: List<OutboxAttachmentEntity>) {
        insertMessage(message)
        if (rows.isNotEmpty()) insertAttachments(rows)
    }

    @Update
    fun updateMessage(message: OutboxEntity): Int

    @Transaction
    fun update(message: OutboxEntity, expectedAttachments: List<OutboxAttachmentEntity>): Int {
        require(attachments(message.origin) == expectedAttachments) {
            "outbox ${message.origin} attachments cannot change during a delivery-state update"
        }
        return updateMessage(message)
    }

    @Query("DELETE FROM outbox WHERE origin = :origin")
    fun delete(origin: String): Int

    @Query("SELECT * FROM outbox WHERE origin = :origin")
    fun find(origin: String): OutboxEntity?

    @Query("SELECT * FROM outbox ORDER BY createdAtMs, origin")
    fun all(): List<OutboxEntity>

    @Transaction
    @Query("SELECT * FROM outbox ORDER BY createdAtMs, origin")
    fun allWithAttachments(): List<OutboxWithAttachments>

    @Query("SELECT * FROM outbox_attachments ORDER BY origin, position")
    fun allAttachments(): List<OutboxAttachmentEntity>

    @Query("SELECT * FROM outbox_attachments WHERE origin = :origin ORDER BY position")
    fun attachments(origin: String): List<OutboxAttachmentEntity>
}

@Dao
interface SyncStateDao {
    @Upsert
    fun upsertReplayState(state: ReplayStateEntity)

    @Upsert
    fun upsertPendingAction(action: PendingControlActionEntity)

    @Query("SELECT * FROM replay_state ORDER BY connectionId")
    fun allReplayStates(): List<ReplayStateEntity>

    @Query("SELECT * FROM pending_control_actions ORDER BY createdAt, id")
    fun allPendingActions(): List<PendingControlActionEntity>

    @Query("SELECT * FROM pending_control_actions WHERE status = 'pending' ORDER BY createdAt, id")
    fun pendingActions(): List<PendingControlActionEntity>
}

@Dao
interface MigrationDao {
    @Upsert
    fun upsertCheckpoint(checkpoint: MigrationCheckpointEntity)

    @Upsert
    fun upsertQuarantine(record: QuarantinedRecordEntity)

    @Query("SELECT * FROM migration_checkpoint WHERE id = 1")
    fun checkpoint(): MigrationCheckpointEntity?

    @Query("SELECT * FROM quarantined_records WHERE sourceKey = :sourceKey AND code = :code AND recordKey = :recordKey")
    fun findQuarantine(sourceKey: String, code: String, recordKey: String): QuarantinedRecordEntity?

    @Query("SELECT * FROM quarantined_records ORDER BY sourceKey, recordKey, code")
    fun allQuarantinedRecords(): List<QuarantinedRecordEntity>
}

@Dao
abstract class OfflineSnapshotDao {
    @Query("SELECT * FROM connections ORDER BY id")
    protected abstract fun connections(): List<ConnectionEntity>

    @Query("SELECT * FROM credential_refs ORDER BY connectionId")
    protected abstract fun credentialRefs(): List<CredentialRefEntity>

    @Query("SELECT * FROM native_credential_refs ORDER BY connectionId")
    protected abstract fun nativeCredentialRefs(): List<NativeCredentialRefEntity>

    @Query("SELECT * FROM app_preferences ORDER BY `key`")
    protected abstract fun preferences(): List<AppPreferenceEntity>

    @Query("SELECT * FROM thread_preferences ORDER BY threadKey")
    protected abstract fun threadPreferences(): List<ThreadPreferenceEntity>

    @Query("SELECT * FROM collapsed_workspaces ORDER BY position, workspaceId")
    protected abstract fun collapsedWorkspaces(): List<CollapsedWorkspaceEntity>

    @Query("SELECT * FROM cached_threads ORDER BY threadKey")
    protected abstract fun cachedThreads(): List<CachedThreadEntity>

    @Query("SELECT * FROM cached_feed_rows ORDER BY threadKey, position, itemId")
    protected abstract fun feedRows(): List<CachedFeedRowEntity>

    @Query("SELECT * FROM outbox ORDER BY createdAtMs, origin")
    protected abstract fun outbox(): List<OutboxEntity>

    @Query("SELECT * FROM outbox_attachments ORDER BY origin, position")
    protected abstract fun outboxAttachments(): List<OutboxAttachmentEntity>

    @Query("SELECT * FROM replay_state ORDER BY connectionId")
    protected abstract fun replayStates(): List<ReplayStateEntity>

    @Query("SELECT * FROM pending_control_actions ORDER BY createdAt, id")
    protected abstract fun pendingControlActions(): List<PendingControlActionEntity>

    @Query("SELECT * FROM quarantined_records ORDER BY sourceKey, recordKey, code")
    protected abstract fun quarantinedRecords(): List<QuarantinedRecordEntity>

    @Transaction
    open fun read(): OfflineSnapshot = OfflineSnapshot(
        connections = connections(),
        credentialRefs = credentialRefs(),
        nativeCredentialRefs = nativeCredentialRefs(),
        preferences = preferences(),
        threadPreferences = threadPreferences(),
        collapsedWorkspaces = collapsedWorkspaces(),
        cachedThreads = cachedThreads(),
        feedRows = feedRows(),
        outbox = outbox(),
        outboxAttachments = outboxAttachments(),
        replayStates = replayStates(),
        pendingControlActions = pendingControlActions(),
        quarantinedRecords = quarantinedRecords(),
    )
}
