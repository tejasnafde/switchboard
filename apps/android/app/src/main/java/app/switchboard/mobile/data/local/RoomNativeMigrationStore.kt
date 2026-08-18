package app.switchboard.mobile.data.local

import app.switchboard.mobile.compat.LegacyDecodeIssue
import app.switchboard.mobile.compat.LegacyIssueSeverity
import app.switchboard.mobile.compat.LegacyThreadPreference
import app.switchboard.mobile.data.MigrationCheckpoint
import app.switchboard.mobile.data.NativeMigrationStore
import app.switchboard.mobile.data.NativeMigrationTransaction
import app.switchboard.mobile.data.NativeMigrationWrite
import java.util.concurrent.Callable

class RoomNativeMigrationStore(
    private val database: SwitchboardDatabase,
) : NativeMigrationStore {
    override fun checkpoint(): MigrationCheckpoint? = database.migrationDao().checkpoint()?.let { row ->
        MigrationCheckpoint(
            sourceFingerprint = row.sourceFingerprint,
            nativeFingerprint = row.nativeFingerprint,
            state = MigrationCheckpoint.State.valueOf(row.state),
        )
    }

    override fun <T> transaction(block: (NativeMigrationTransaction) -> T): T =
        database.runInTransaction(Callable { block(RoomMigrationTransaction(database)) })
}

private class RoomMigrationTransaction(
    private val database: SwitchboardDatabase,
) : NativeMigrationTransaction {
    private val appliedWrites = mutableListOf<NativeMigrationWrite.Upsert>()

    override fun upsert(write: NativeMigrationWrite.Upsert) {
        when (write) {
            is NativeMigrationWrite.UpsertConnection ->
                database.connectionDao().upsertWithNativeCredential(
                    LocalMigrationMapper.connection(write),
                    NativeCredentialRefEntity(write.connectionId, write.connectionId),
                )
            is NativeMigrationWrite.UpsertCredentialReferences ->
                database.connectionDao().upsertCredentialRefs(LocalMigrationMapper.credentialRefs(write))
            is NativeMigrationWrite.UpsertDefaultMode ->
                database.preferenceDao().upsertPreference(AppPreferenceEntity(DEFAULT_MODE_KEY, write.mode))
            is NativeMigrationWrite.UpsertThreadPreference ->
                database.preferenceDao().upsertThreadPreference(LocalMigrationMapper.threadPreference(write))
            is NativeMigrationWrite.UpsertCollapsedWorkspaces ->
                database.preferenceDao().replaceCollapsedWorkspaces(
                    write.workspaceIds.mapIndexed { index, id -> CollapsedWorkspaceEntity(id, index) },
                )
            is NativeMigrationWrite.UpsertCachedThread -> {
                val mapped = LocalMigrationMapper.cachedThread(write)
                database.cacheDao().upsertThread(mapped.thread)
                database.cacheDao().replaceFeedRows(write.threadKey, mapped.feed)
            }
            is NativeMigrationWrite.UpsertOutbox -> {
                val mapped = LocalMigrationMapper.outbox(write)
                database.outboxDao().insert(mapped.message, mapped.attachments)
            }
            is NativeMigrationWrite.UpsertQuarantine ->
                database.migrationDao().upsertQuarantine(LocalMigrationMapper.quarantine(write))
        }
        appliedWrites += write
    }

    override fun contentFingerprint(): String = LocalMigrationFingerprint.fingerprint(
        appliedWrites.map(::readBack),
    )

    override fun markComplete(checkpoint: MigrationCheckpoint) {
        database.migrationDao().upsertCheckpoint(
            MigrationCheckpointEntity(
                sourceFingerprint = checkpoint.sourceFingerprint,
                nativeFingerprint = checkpoint.nativeFingerprint,
                state = checkpoint.state.name,
            ),
        )
    }

    private fun readBack(write: NativeMigrationWrite.Upsert): NativeMigrationWrite.Upsert = when (write) {
        is NativeMigrationWrite.UpsertConnection -> {
            val row = requireNotNull(database.connectionDao().find(write.connectionId))
            NativeMigrationWrite.UpsertConnection(
                connectionId = row.id,
                connection = LocalMigrationMapper.readbackConnection(row, write.connection),
            )
        }
        is NativeMigrationWrite.UpsertCredentialReferences -> {
            val row = requireNotNull(database.connectionDao().findCredentialRefs(write.connectionId))
            NativeMigrationWrite.UpsertCredentialReferences(
                connectionId = row.connectionId,
                tokenLogicalKey = row.tokenLogicalKey,
                sessionLogicalKey = row.sessionLogicalKey,
            )
        }
        is NativeMigrationWrite.UpsertDefaultMode -> {
            val row = requireNotNull(database.preferenceDao().findPreference(DEFAULT_MODE_KEY))
            NativeMigrationWrite.UpsertDefaultMode(row.value)
        }
        is NativeMigrationWrite.UpsertThreadPreference -> {
            val row = requireNotNull(database.preferenceDao().findThreadPreference(write.threadKey))
            NativeMigrationWrite.UpsertThreadPreference(
                threadKey = row.threadKey,
                preference = LegacyThreadPreference(
                    mode = row.mode,
                    model = row.model,
                    draft = row.draft,
                    touchedAt = row.touchedAt,
                ),
            )
        }
        is NativeMigrationWrite.UpsertCollapsedWorkspaces -> NativeMigrationWrite.UpsertCollapsedWorkspaces(
            database.preferenceDao().allCollapsedWorkspaces().map { it.workspaceId },
        )
        is NativeMigrationWrite.UpsertCachedThread -> {
            val row = requireNotNull(database.cacheDao().findThread(write.threadKey))
            val expectedFeed = LocalMigrationMapper.cachedThread(
                NativeMigrationWrite.UpsertCachedThread(row.threadKey, row.rawJson),
            ).feed
            require(database.cacheDao().feedRows(write.threadKey) == expectedFeed) { "cached feed rows differ" }
            NativeMigrationWrite.UpsertCachedThread(row.threadKey, row.rawJson)
        }
        is NativeMigrationWrite.UpsertOutbox -> {
            val row = requireNotNull(database.outboxDao().find(write.messageId))
            require(database.outboxDao().attachments(write.messageId).isEmpty()) {
                "legacy outbox row contains unverified attachment paths"
            }
            NativeMigrationWrite.UpsertOutbox(row.origin, requireNotNull(row.legacyRawJson))
        }
        is NativeMigrationWrite.UpsertQuarantine -> {
            val mapped = LocalMigrationMapper.quarantine(write)
            val row = requireNotNull(
                database.migrationDao().findQuarantine(mapped.sourceKey, mapped.code, mapped.recordKey),
            )
            NativeMigrationWrite.UpsertQuarantine(
                LegacyDecodeIssue(
                    sourceKey = row.sourceKey,
                    code = row.code,
                    detail = row.detail,
                    severity = LegacyIssueSeverity.valueOf(row.severity),
                    recordId = row.recordKey.ifEmpty { null },
                ),
            )
        }
    }

    private companion object {
        const val DEFAULT_MODE_KEY = "defaultMode"
    }
}
