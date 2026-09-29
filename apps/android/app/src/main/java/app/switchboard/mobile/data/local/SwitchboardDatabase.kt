package app.switchboard.mobile.data.local

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration

@Database(
    entities = [
        ConnectionEntity::class,
        CredentialRefEntity::class,
        NativeCredentialRefEntity::class,
        AppPreferenceEntity::class,
        ThreadPreferenceEntity::class,
        ComposerDraftAttachmentEntity::class,
        CollapsedWorkspaceEntity::class,
        CachedThreadEntity::class,
        CachedFeedRowEntity::class,
        BrowseSnapshotEntity::class,
        PendingWorktreeCreationEntity::class,
        OutboxEntity::class,
        OutboxAttachmentEntity::class,
        ReplayStateEntity::class,
        PendingControlActionEntity::class,
        MigrationCheckpointEntity::class,
        QuarantinedRecordEntity::class,
    ],
    version = 7,
    exportSchema = true,
)
abstract class SwitchboardDatabase : RoomDatabase() {
    abstract fun connectionDao(): ConnectionDao
    abstract fun preferenceDao(): PreferenceDao
    abstract fun composerDraftDao(): ComposerDraftDao
    abstract fun cacheDao(): CacheDao
    abstract fun outboxDao(): OutboxDao
    abstract fun syncStateDao(): SyncStateDao
    abstract fun migrationDao(): MigrationDao
    abstract fun offlineSnapshotDao(): OfflineSnapshotDao
    abstract fun browseSnapshotDao(): BrowseSnapshotDao
    abstract fun pendingWorktreeCreationDao(): PendingWorktreeCreationDao

    /**
     * The offline snapshot plus any user row too big for Room's own queries, read
     * back in chunks. Use this, not `offlineSnapshotDao().read()`, so a large queued
     * message or draft is never missing from the snapshot.
     */
    fun readOfflineSnapshot(): OfflineSnapshot = runInTransaction<OfflineSnapshot> {
        recovery().complete(offlineSnapshotDao().read())
    }

    fun recoveredOutbox(): List<OutboxWithAttachments> =
        recovery().outbox().map { OutboxWithAttachments(it, outboxDao().attachments(it.origin)) }

    fun recoveredDrafts(): List<ComposerDraftWithAttachments> =
        recovery().threadPreferences().map {
            ComposerDraftWithAttachments(it, composerDraftDao().attachments(it.threadKey))
        }

    internal fun recovery(): UserRowRecovery = UserRowRecovery(openHelper.writableDatabase)

    companion object {
        const val DATABASE_NAME = "switchboard-native.db"
        val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS `native_credential_refs` (
                        `connectionId` TEXT NOT NULL,
                        `logicalKey` TEXT NOT NULL,
                        PRIMARY KEY(`connectionId`),
                        FOREIGN KEY(`connectionId`) REFERENCES `connections`(`id`)
                            ON UPDATE NO ACTION ON DELETE CASCADE
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS `index_native_credential_refs_connectionId` " +
                        "ON `native_credential_refs` (`connectionId`)",
                )
                // v1 native credentials were keyed by connection id. Point to
                // them in place; do not move or delete any encrypted value.
                db.execSQL(
                    "INSERT OR IGNORE INTO `native_credential_refs` (`connectionId`, `logicalKey`) " +
                        "SELECT `id`, `id` FROM `connections`",
                )
                migrateOutboxV1(db)
            }
        }
        val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `thread_preferences` ADD COLUMN `editingOrigin` TEXT")
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS `draft_attachments` (
                        `threadKey` TEXT NOT NULL,
                        `position` INTEGER NOT NULL,
                        `attachmentId` TEXT NOT NULL,
                        `privatePath` TEXT NOT NULL,
                        `mimeType` TEXT,
                        `displayName` TEXT NOT NULL,
                        PRIMARY KEY(`threadKey`, `position`),
                        FOREIGN KEY(`threadKey`) REFERENCES `thread_preferences`(`threadKey`)
                            ON UPDATE NO ACTION ON DELETE CASCADE
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS `index_draft_attachments_threadKey` " +
                        "ON `draft_attachments` (`threadKey`)",
                )
            }
        }
        val MIGRATION_3_4 = object : Migration(3, 4) {
            override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS `browse_snapshots` (
                        `snapshotKey` TEXT NOT NULL,
                        `connectionId` TEXT NOT NULL,
                        `kind` TEXT NOT NULL,
                        `projectPath` TEXT,
                        `rawJson` TEXT NOT NULL,
                        `updatedAtMs` INTEGER NOT NULL,
                        PRIMARY KEY(`snapshotKey`),
                        FOREIGN KEY(`connectionId`) REFERENCES `connections`(`id`)
                            ON UPDATE NO ACTION ON DELETE CASCADE
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS `index_browse_snapshots_connectionId` " +
                        "ON `browse_snapshots` (`connectionId`)",
                )
            }
        }
        val MIGRATION_4_5 = object : Migration(4, 5) {
            override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS `pending_worktree_creations` (
                        `creationId` TEXT NOT NULL,
                        `connectionId` TEXT NOT NULL,
                        `projectPath` TEXT NOT NULL,
                        `requestJson` TEXT NOT NULL,
                        `updatedAtMs` INTEGER NOT NULL,
                        PRIMARY KEY(`creationId`),
                        FOREIGN KEY(`connectionId`) REFERENCES `connections`(`id`)
                            ON UPDATE NO ACTION ON DELETE CASCADE
                    )
                    """.trimIndent(),
                )
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS `index_pending_worktree_creations_connectionId` " +
                        "ON `pending_worktree_creations` (`connectionId`)",
                )
                db.execSQL(
                    "CREATE UNIQUE INDEX IF NOT EXISTS " +
                        "`index_pending_worktree_creations_connectionId_projectPath` " +
                        "ON `pending_worktree_creations` (`connectionId`, `projectPath`)",
                )
            }
        }
        /** A queued follow-up's steer/queue choice; null for every older row. */
        val MIGRATION_5_6 = object : Migration(5, 6) {
            override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `outbox` ADD COLUMN `delivery` TEXT")
            }
        }
        /**
         * Composer drafts and queued turns stored a runtime mode even when nobody
         * picked one ("sandbox" by default), and every turn re-sent it, dropping a
         * chat set to full access on the desktop. A mode now means a pick made on
         * the phone, so the stored values, which cannot tell the two apart, go.
         * A turn already tried keeps its mode: the mode is part of the backend's
         * fingerprint for its origin, and a changed retry is refused as a conflict.
         */
        val MIGRATION_6_7 = object : Migration(6, 7) {
            override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
                db.execSQL("UPDATE `outbox` SET `runtimeMode` = NULL WHERE `attempts` = 0 AND `deliveryState` = 'pending'")
                db.execSQL("UPDATE `thread_preferences` SET `mode` = NULL")
            }
        }
        private val EXPLICIT_MIGRATIONS: Array<Migration> =
            arrayOf(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4, MIGRATION_4_5, MIGRATION_5_6, MIGRATION_6_7)

        fun open(context: Context): SwitchboardDatabase = builder(context).build()

        internal fun builder(context: Context): RoomDatabase.Builder<SwitchboardDatabase> = Room.databaseBuilder(
            context.applicationContext,
            SwitchboardDatabase::class.java,
            DATABASE_NAME,
        ).addMigrations(*EXPLICIT_MIGRATIONS).addCallback(OVERSIZED_ROW_REPAIR)

        /**
         * Runs on every open, after migrations and before the first DAO query, so a
         * phone that already holds a row too big for a CursorWindow is repaired on
         * the next launch rather than blocked on it.
         */
        private val OVERSIZED_ROW_REPAIR = object : Callback() {
            override fun onOpen(db: androidx.sqlite.db.SupportSQLiteDatabase) {
                try {
                    OversizedRowRepair.run(db)
                } catch (error: RuntimeException) {
                    AndroidCacheLog.warn("oversized row repair failed: ${error.javaClass.simpleName}")
                }
            }
        }

        private fun migrateOutboxV1(database: androidx.sqlite.db.SupportSQLiteDatabase) {
            database.execSQL(
                """
                CREATE TABLE `outbox_v2` (
                    `origin` TEXT NOT NULL,
                    `bubbleId` TEXT NOT NULL,
                    `connectionId` TEXT NOT NULL,
                    `threadId` TEXT NOT NULL,
                    `text` TEXT NOT NULL,
                    `runtimeMode` TEXT,
                    `createdAtMs` INTEGER NOT NULL,
                    `attempts` INTEGER NOT NULL,
                    `nextAttemptAtMs` INTEGER NOT NULL,
                    `deliveryState` TEXT NOT NULL,
                    `stateReason` TEXT,
                    `receiptLegacy` INTEGER,
                    `receiptDuplicate` INTEGER,
                    `receiptRawJson` TEXT,
                    `legacyRawJson` TEXT,
                    PRIMARY KEY(`origin`)
                )
                """.trimIndent(),
            )
            database.execSQL(
                """
                INSERT INTO `outbox_v2` (
                    `origin`, `bubbleId`, `connectionId`, `threadId`, `text`, `runtimeMode`,
                    `createdAtMs`, `attempts`, `nextAttemptAtMs`, `deliveryState`,
                    `stateReason`, `receiptLegacy`, `receiptDuplicate`, `receiptRawJson`, `legacyRawJson`
                )
                SELECT
                    `messageId`, 'remote_' || `messageId`, `connectionId`, `threadId`, `text`, `runtimeMode`,
                    `createdAt`, `attempts`, `createdAt`, 'pending', NULL, NULL, NULL, NULL, `rawJson`
                FROM `outbox`
                """.trimIndent(),
            )
            database.execSQL(
                """
                CREATE TABLE `outbox_attachments_v2` (
                    `origin` TEXT NOT NULL,
                    `position` INTEGER NOT NULL,
                    `privatePath` TEXT NOT NULL,
                    `mimeType` TEXT,
                    PRIMARY KEY(`origin`, `position`),
                    FOREIGN KEY(`origin`) REFERENCES `outbox_v2`(`origin`)
                        ON UPDATE NO ACTION ON DELETE CASCADE
                )
                """.trimIndent(),
            )
            database.execSQL(
                """
                INSERT INTO `outbox_attachments_v2` (`origin`, `position`, `privatePath`, `mimeType`)
                SELECT `messageId`, `position`, `privatePath`, `mimeType`
                FROM `outbox_attachments`
                """.trimIndent(),
            )
            database.execSQL("DROP TABLE `outbox_attachments`")
            database.execSQL("DROP TABLE `outbox`")
            database.execSQL("ALTER TABLE `outbox_v2` RENAME TO `outbox`")
            database.execSQL("ALTER TABLE `outbox_attachments_v2` RENAME TO `outbox_attachments`")
            database.execSQL(
                "CREATE INDEX `index_outbox_connectionId` ON `outbox` (`connectionId`)",
            )
            database.execSQL(
                "CREATE INDEX `index_outbox_createdAtMs` ON `outbox` (`createdAtMs`)",
            )
            database.execSQL(
                "CREATE INDEX `index_outbox_attachments_origin` ON `outbox_attachments` (`origin`)",
            )
        }
    }
}
