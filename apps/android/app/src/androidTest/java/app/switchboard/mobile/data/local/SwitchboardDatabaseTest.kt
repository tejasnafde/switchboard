package app.switchboard.mobile.data.local

import android.content.Context
import androidx.room.Room
import androidx.room.testing.MigrationTestHelper
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.switchboard.mobile.compat.LegacyStateDecoder
import app.switchboard.mobile.data.MigrationCheckpoint
import app.switchboard.mobile.data.MigrationDecision
import app.switchboard.mobile.data.MigrationExecution
import app.switchboard.mobile.data.MigrationExecutor
import app.switchboard.mobile.data.MigrationPlanner
import app.switchboard.mobile.data.composer.RoomComposerDraftStore
import app.switchboard.mobile.domain.composer.ComposerAttachment
import app.switchboard.mobile.domain.composer.ComposerDraft
import app.switchboard.mobile.domain.composer.ComposerDraftKey
import java.io.Closeable
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SwitchboardDatabaseTest {
    @get:Rule
    val migrationHelper = MigrationTestHelper(
        InstrumentationRegistry.getInstrumentation(),
        SwitchboardDatabase::class.java,
    )

    private lateinit var database: SwitchboardDatabase

    @Before
    fun createDatabase() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        database = Room.inMemoryDatabaseBuilder(context, SwitchboardDatabase::class.java)
            .allowMainThreadQueries()
            .build()
    }

    @After
    fun closeDatabase() {
        database.close()
    }

    @Test
    fun offlineSnapshotIncludesTopologyPreferencesCacheOutboxAndSyncState() {
        database.connectionDao().upsertWithNativeCredential(
            ConnectionEntity("lan", "Mac", "ws", "ws://mac", null, null, null, null),
            NativeCredentialRefEntity("lan", "native-active-key"),
        )
        database.connectionDao().upsertCredentialRefs(CredentialRefEntity("lan", "token-key", "session-key"))
        database.preferenceDao().upsertPreference(AppPreferenceEntity("defaultMode", "sandbox"))
        database.preferenceDao().upsertThreadPreference(
            ThreadPreferenceEntity("lan:t", "plan", "codex", "draft", 4),
        )
        database.preferenceDao().replaceCollapsedWorkspaces(listOf(CollapsedWorkspaceEntity("ops", 0)))
        database.cacheDao().upsertThread(CachedThreadEntity("lan:t", "{\"items\":[]}"))
        database.cacheDao().replaceFeedRows(
            "lan:t",
            listOf(CachedFeedRowEntity("lan:t", "i1", 0, "{\"id\":\"i1\"}")),
        )
        database.outboxDao().insert(
            pendingOutbox("m1", attempts = 1, legacyRawJson = "{\"messageId\":\"m1\"}"),
            listOf(OutboxAttachmentEntity("m1", 0, "attachments/m1/0.png", "image/png")),
        )
        database.syncStateDao().upsertReplayState(ReplayStateEntity("lan", "epoch-a", 42))
        database.syncStateDao().upsertPendingAction(
            PendingControlActionEntity(
                id = "control-1",
                connectionId = "lan",
                channel = "provider:interrupt",
                argsJson = "[\"t\"]",
                requestId = "request-1",
                idempotencyKey = "idem-1",
                createdAt = 10,
                attempts = 0,
                status = "pending",
                lastError = null,
            ),
        )
        database.browseSnapshotDao().upsert(
            BrowseSnapshotEntity(
                snapshotKey = "[\"lan\",\"projects\",null]",
                connectionId = "lan",
                kind = "projects",
                projectPath = null,
                rawJson = "[]",
                updatedAtMs = 12,
            ),
        )

        val snapshot = database.offlineSnapshotDao().read()

        assertEquals(listOf("lan"), snapshot.connections.map { it.id })
        assertEquals("session-key", snapshot.credentialRefs.single().sessionLogicalKey)
        assertEquals("native-active-key", snapshot.nativeCredentialRefs.single().logicalKey)
        assertEquals("draft", snapshot.threadPreferences.single().draft)
        assertEquals("i1", snapshot.feedRows.single().itemId)
        assertEquals("attachments/m1/0.png", snapshot.outboxAttachments.single().privatePath)
        assertEquals(42, snapshot.replayStates.single().lastSequence)
        assertEquals("idem-1", snapshot.pendingControlActions.single().idempotencyKey)
        assertEquals("projects", snapshot.browseSnapshots.single().kind)
    }

    @Test
    fun deletingAnOutboxMessageCascadesOnlyItsPrivateAttachmentRows() {
        database.outboxDao().insert(
            pendingOutbox("m1", legacyRawJson = "{}"),
            listOf(OutboxAttachmentEntity("m1", 0, "attachments/m1/0.png", "image/png")),
        )

        database.outboxDao().delete("m1")

        assertTrue(database.outboxDao().all().isEmpty())
        assertTrue(database.outboxDao().allAttachments().isEmpty())
    }

    @Test
    fun deletingAConnectionCascadesItsBrowseCacheSoAReusedIdCannotSeeStaleRows() {
        database.connectionDao().upsert(
            ConnectionEntity("lan", "Mac", "ws", "ws://mac", null, null, null, null),
        )
        database.browseSnapshotDao().upsert(
            BrowseSnapshotEntity("key", "lan", "projects", null, "[]", 1),
        )

        database.connectionDao().delete("lan")

        assertTrue(database.browseSnapshotDao().forConnection("lan").isEmpty())
    }

    @Test
    fun duplicateOutboxOriginAbortsWithoutReplacingTheDurableRow() {
        val original = pendingOutbox("same-origin")
        database.outboxDao().insert(original, emptyList())

        val duplicate = runCatching {
            database.outboxDao().insert(original.copy(text = "must not replace"), emptyList())
        }

        assertTrue(duplicate.isFailure)
        assertEquals("queued", database.outboxDao().find(original.origin)?.text)
    }

    @Test
    fun deliveryStateUpdatePreservesAttachmentRows() {
        val pending = pendingOutbox("ack-origin")
        val attachment = OutboxAttachmentEntity("ack-origin", 0, "attachments/ack/0.png", "image/png")
        database.outboxDao().insert(pending, listOf(attachment))

        val changed = database.outboxDao().update(
            pending.copy(
                attempts = 2,
                nextAttemptAtMs = 20,
                deliveryState = "acknowledged",
                receiptLegacy = false,
                receiptDuplicate = true,
                receiptRawJson = "{\"accepted\":true}",
            ),
            listOf(attachment),
        )

        assertEquals(1, changed)
        assertEquals("acknowledged", database.outboxDao().find(pending.origin)?.deliveryState)
        assertEquals(listOf(attachment), database.outboxDao().attachments(pending.origin))
    }

    @Test
    fun updatingAConnectionDoesNotCascadeDeleteItsCredentialReferences() {
        database.connectionDao().upsert(
            ConnectionEntity("lan", "Old label", "ws", "ws://mac", null, null, null, null),
        )
        database.connectionDao().upsertCredentialRefs(CredentialRefEntity("lan", "token", "session"))

        database.connectionDao().upsert(
            ConnectionEntity("lan", "New label", "ws", "ws://mac", null, null, null, null),
        )

        assertEquals("New label", database.connectionDao().find("lan")?.label)
        assertEquals("session", database.connectionDao().findCredentialRefs("lan")?.sessionLogicalKey)
    }

    @Test
    fun feedRowsUsePositionAsIdentitySoDuplicateLegacyItemIdsRemainLossless() {
        database.cacheDao().upsertThread(CachedThreadEntity("lan:t", "{\"items\":[]}"))
        database.cacheDao().replaceFeedRows(
            "lan:t",
            listOf(
                CachedFeedRowEntity("lan:t", "duplicate", 0, "{\"id\":\"duplicate\",\"text\":\"one\"}"),
                CachedFeedRowEntity("lan:t", "duplicate", 1, "{\"id\":\"duplicate\",\"text\":\"two\"}"),
            ),
        )

        assertEquals(listOf(0, 1), database.cacheDao().feedRows("lan:t").map { it.position })
    }

    @Test
    fun roomMigrationStoreVerifiesReadbackAndCheckpointsInTheSameTransaction() {
        val report = LegacyStateDecoder.decode(
            mapOf(
                "sb-connections" to
                    """{"state":{"configs":[{"id":"legacy","label":"Mac","kind":"ws","url":"ws://mac","token":"do-not-store-inline"}]},"version":0}""",
                "switchboard-prefs" to
                    """{"state":{"threads":{},"defaultMode":"sandbox","collapsedWorkspaces":[]},"version":0}""",
                "sb-outbox:m1" to
                    """{"connectionId":"legacy","threadId":"t","messageId":"m1","text":"queued","createdAt":4,"attempts":1}""",
            ),
        )
        val plan = (MigrationPlanner.plan(report) as MigrationDecision.Ready).plan
        val store = RoomNativeMigrationStore(database)

        assertEquals(MigrationExecution.MIGRATED, MigrationExecutor.execute(plan, store))

        assertEquals(MigrationCheckpoint.complete(plan), store.checkpoint())
        assertFalse(database.connectionDao().all().single().toString().contains("do-not-store-inline"))
        assertEquals("legacy", database.connectionDao().findNativeCredentialRef("legacy")?.logicalKey)
        assertEquals("queued", database.outboxDao().all().single().text)
        assertEquals(MigrationExecution.ALREADY_COMPLETE, MigrationExecutor.execute(plan, store))
    }

    @Test
    fun transactionFailureRollsBackRowsAndCompletionCheckpointTogether() {
        val store = RoomNativeMigrationStore(database)

        runCatching {
            store.transaction { transaction ->
                transaction.upsert(
                    app.switchboard.mobile.data.NativeMigrationWrite.UpsertDefaultMode("sandbox"),
                )
                error("stop before checkpoint")
            }
        }

        assertTrue(database.preferenceDao().allPreferences().isEmpty())
        assertNull(store.checkpoint())
    }

    @Test
    fun composerWritesAndClearPreserveExistingThreadModelAndModePreference() {
        val key = ComposerDraftKey("lan", "thread")
        database.preferenceDao().upsertThreadPreference(
            ThreadPreferenceEntity(
                threadKey = key.storageKey,
                mode = "sandbox",
                model = "gpt-existing",
                draft = null,
                touchedAt = 1,
            ),
        )
        val store = RoomComposerDraftStore(database.composerDraftDao())
        store.save(
            ComposerDraft(
                key = key,
                text = "durable",
                runtimeMode = "plan",
                attachments = listOf(
                    ComposerAttachment("image", "/private/image", "image/png", "image.png"),
                ),
            ),
        )

        assertEquals("gpt-existing", database.preferenceDao().findThreadPreference(key.storageKey)?.model)
        store.delete(key)

        val preserved = database.preferenceDao().findThreadPreference(key.storageKey)
        assertEquals("gpt-existing", preserved?.model)
        assertEquals("plan", preserved?.mode)
        assertNull(preserved?.draft)
        assertTrue(database.composerDraftDao().allWithAttachments().single().attachments.isEmpty())
    }

    @Test
    fun migrationTwoToThreePreservesDraftAndAddsAttachmentOwnership() {
        val name = "composer-migration-test"
        migrationHelper.createDatabase(name, 2).apply {
            execSQL(
                "INSERT INTO thread_preferences " +
                    "(threadKey, mode, model, draft, touchedAt) VALUES (?, ?, ?, ?, ?)",
                arrayOf<Any?>("lan:thread", "plan", "codex", "keep me", 42L),
            )
            close()
        }

        migrationHelper.runMigrationsAndValidate(
            name,
            3,
            true,
            SwitchboardDatabase.MIGRATION_2_3,
        ).use { migrated ->
            migrated.query(
                "SELECT mode, draft, editingOrigin FROM thread_preferences WHERE threadKey = ?",
                arrayOf("lan:thread"),
            ).use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertEquals("plan", cursor.getString(0))
                assertEquals("keep me", cursor.getString(1))
                assertNull(cursor.getString(2))
            }
            migrated.execSQL(
                "INSERT INTO draft_attachments " +
                    "(threadKey, position, attachmentId, privatePath, mimeType, displayName) " +
                    "VALUES (?, ?, ?, ?, ?, ?)",
                arrayOf<Any?>(
                    "lan:thread",
                    0,
                    "image-1",
                    "/private/image-1",
                    "image/png",
                    "one.png",
                ),
            )
            migrated.query(
                "SELECT privatePath FROM draft_attachments WHERE threadKey = ?",
                arrayOf("lan:thread"),
            ).use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertEquals("/private/image-1", cursor.getString(0))
            }
        }
    }

    @Test
    fun migrationThreeToFourPreservesExistingRowsAndAddsBrowseSnapshots() {
        val name = "browse-snapshot-migration-test"
        migrationHelper.createDatabase(name, 3).apply {
            execSQL(
                "INSERT INTO connections (id, label, kind, url, project, zone, instance, port) " +
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                arrayOf<Any?>("lan", "Mac", "ws", "ws://mac", null, null, null, null),
            )
            execSQL(
                "INSERT INTO app_preferences (`key`, value) VALUES (?, ?)",
                arrayOf<Any?>("defaultMode", "sandbox"),
            )
            close()
        }

        migrationHelper.runMigrationsAndValidate(
            name,
            4,
            true,
            SwitchboardDatabase.MIGRATION_3_4,
        ).use { migrated ->
            migrated.query("SELECT value FROM app_preferences WHERE `key` = 'defaultMode'").use {
                assertTrue(it.moveToFirst())
                assertEquals("sandbox", it.getString(0))
            }
            migrated.execSQL(
                "INSERT INTO browse_snapshots " +
                    "(snapshotKey, connectionId, kind, projectPath, rawJson, updatedAtMs) " +
                    "VALUES (?, ?, ?, ?, ?, ?)",
                arrayOf<Any?>("key", "lan", "projects", null, "[]", 1L),
            )
            migrated.query("SELECT kind FROM browse_snapshots WHERE snapshotKey = 'key'").use {
                assertTrue(it.moveToFirst())
                assertEquals("projects", it.getString(0))
            }
        }
    }

    @Test
    fun migrationOneToFourPreservesDurableStateAndTransformsOutboxWithoutLoss() {
        val name = "full-chain-migration-test"
        migrationHelper.createDatabase(name, 1).apply {
            execSQL(
                "INSERT INTO connections (id, label, kind, url, project, zone, instance, port) " +
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                arrayOf<Any?>("lan", "Mac", "ws", "ws://mac", "/repo", null, null, null),
            )
            execSQL(
                "INSERT INTO credential_refs (connectionId, tokenLogicalKey, sessionLogicalKey) " +
                    "VALUES (?, ?, ?)",
                arrayOf<Any?>("lan", "token-key", "session-key"),
            )
            execSQL(
                "INSERT INTO app_preferences (`key`, value) VALUES (?, ?)",
                arrayOf<Any?>("defaultMode", "sandbox"),
            )
            execSQL(
                "INSERT INTO thread_preferences " +
                    "(threadKey, mode, model, draft, touchedAt) VALUES (?, ?, ?, ?, ?)",
                arrayOf<Any?>("lan:thread", "plan", "codex", "keep draft", 42L),
            )
            execSQL(
                "INSERT INTO collapsed_workspaces (workspaceId, position) VALUES (?, ?)",
                arrayOf<Any?>("workspace", 3),
            )
            execSQL(
                "INSERT INTO cached_threads (threadKey, rawJson) VALUES (?, ?)",
                arrayOf<Any?>("lan:thread", "{\"title\":\"Keep\"}"),
            )
            execSQL(
                "INSERT INTO cached_feed_rows (threadKey, itemId, position, rawJson) " +
                    "VALUES (?, ?, ?, ?)",
                arrayOf<Any?>("lan:thread", "item", 0, "{\"text\":\"Keep chat\"}"),
            )
            execSQL(
                "INSERT INTO outbox " +
                    "(messageId, connectionId, threadId, text, runtimeMode, createdAt, attempts, rawJson) " +
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                arrayOf<Any?>(
                    "message-1",
                    "lan",
                    "thread",
                    "send later",
                    "sandbox",
                    99L,
                    2,
                    "{\"messageId\":\"message-1\"}",
                ),
            )
            execSQL(
                "INSERT INTO outbox_attachments (messageId, position, privatePath, mimeType) " +
                    "VALUES (?, ?, ?, ?)",
                arrayOf<Any?>("message-1", 0, "attachments/message-1/0.png", "image/png"),
            )
            execSQL(
                "INSERT INTO replay_state (connectionId, epoch, lastSequence) VALUES (?, ?, ?)",
                arrayOf<Any?>("lan", "epoch-a", 7L),
            )
            execSQL(
                "INSERT INTO pending_control_actions " +
                    "(id, connectionId, channel, argsJson, requestId, idempotencyKey, createdAt, " +
                    "attempts, status, lastError) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                arrayOf<Any?>(
                    "control-1",
                    "lan",
                    "provider:interrupt",
                    "[\"thread\"]",
                    "request-1",
                    "idem-1",
                    101L,
                    1,
                    "pending",
                    "retry",
                ),
            )
            execSQL(
                "INSERT INTO migration_checkpoint " +
                    "(id, sourceFingerprint, nativeFingerprint, state) VALUES (?, ?, ?, ?)",
                arrayOf<Any?>(1, "source", "native", "complete"),
            )
            execSQL(
                "INSERT INTO quarantined_records " +
                    "(sourceKey, code, recordKey, detail, severity) VALUES (?, ?, ?, ?, ?)",
                arrayOf<Any?>("legacy-key", "invalid", "record", "keep detail", "warning"),
            )
            close()
        }

        migrationHelper.runMigrationsAndValidate(
            name,
            4,
            true,
            SwitchboardDatabase.MIGRATION_1_2,
            SwitchboardDatabase.MIGRATION_2_3,
            SwitchboardDatabase.MIGRATION_3_4,
        ).use { migrated ->
            listOf(
                "connections",
                "credential_refs",
                "native_credential_refs",
                "app_preferences",
                "thread_preferences",
                "collapsed_workspaces",
                "cached_threads",
                "cached_feed_rows",
                "outbox",
                "outbox_attachments",
                "replay_state",
                "pending_control_actions",
                "migration_checkpoint",
                "quarantined_records",
            ).forEach { table ->
                migrated.query("SELECT COUNT(*) FROM `$table`").use { cursor ->
                    assertTrue(cursor.moveToFirst())
                    assertEquals("Unexpected row count for $table", 1, cursor.getInt(0))
                }
            }
            migrated.query(
                "SELECT label, kind, url, project FROM connections WHERE id = 'lan'",
            ).use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertEquals("Mac", cursor.getString(0))
                assertEquals("ws", cursor.getString(1))
                assertEquals("ws://mac", cursor.getString(2))
                assertEquals("/repo", cursor.getString(3))
            }
            migrated.query(
                "SELECT tokenLogicalKey, sessionLogicalKey FROM credential_refs " +
                    "WHERE connectionId = 'lan'",
            ).use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertEquals("token-key", cursor.getString(0))
                assertEquals("session-key", cursor.getString(1))
            }
            migrated.query(
                "SELECT logicalKey FROM native_credential_refs WHERE connectionId = 'lan'",
            ).use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertEquals("lan", cursor.getString(0))
            }
            migrated.query(
                "SELECT value FROM app_preferences WHERE `key` = 'defaultMode'",
            ).use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertEquals("sandbox", cursor.getString(0))
            }
            migrated.query(
                "SELECT mode, model, draft, touchedAt, editingOrigin FROM thread_preferences " +
                    "WHERE threadKey = 'lan:thread'",
            ).use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertEquals("plan", cursor.getString(0))
                assertEquals("codex", cursor.getString(1))
                assertEquals("keep draft", cursor.getString(2))
                assertEquals(42L, cursor.getLong(3))
                assertNull(cursor.getString(4))
            }
            migrated.query(
                "SELECT position FROM collapsed_workspaces WHERE workspaceId = 'workspace'",
            ).use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertEquals(3, cursor.getInt(0))
            }
            migrated.query(
                "SELECT rawJson FROM cached_threads WHERE threadKey = 'lan:thread'",
            ).use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertEquals("{\"title\":\"Keep\"}", cursor.getString(0))
            }
            migrated.query(
                "SELECT itemId, position, rawJson FROM cached_feed_rows " +
                    "WHERE threadKey = 'lan:thread'",
            ).use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertEquals("item", cursor.getString(0))
                assertEquals(0, cursor.getInt(1))
                assertEquals("{\"text\":\"Keep chat\"}", cursor.getString(2))
            }
            migrated.query(
                "SELECT bubbleId, connectionId, threadId, text, runtimeMode, createdAtMs, " +
                    "attempts, nextAttemptAtMs, deliveryState, stateReason, receiptRawJson, " +
                    "legacyRawJson FROM outbox WHERE origin = 'message-1'",
            ).use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertEquals("remote_message-1", cursor.getString(0))
                assertEquals("lan", cursor.getString(1))
                assertEquals("thread", cursor.getString(2))
                assertEquals("send later", cursor.getString(3))
                assertEquals("sandbox", cursor.getString(4))
                assertEquals(99L, cursor.getLong(5))
                assertEquals(2, cursor.getInt(6))
                assertEquals(99L, cursor.getLong(7))
                assertEquals("pending", cursor.getString(8))
                assertNull(cursor.getString(9))
                assertNull(cursor.getString(10))
                assertEquals("{\"messageId\":\"message-1\"}", cursor.getString(11))
            }
            migrated.query(
                "SELECT position, privatePath, mimeType FROM outbox_attachments " +
                    "WHERE origin = 'message-1'",
            ).use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertEquals(0, cursor.getInt(0))
                assertEquals("attachments/message-1/0.png", cursor.getString(1))
                assertEquals("image/png", cursor.getString(2))
            }
            migrated.query(
                "SELECT epoch, lastSequence FROM replay_state WHERE connectionId = 'lan'",
            ).use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertEquals("epoch-a", cursor.getString(0))
                assertEquals(7L, cursor.getLong(1))
            }
            migrated.query(
                "SELECT channel, argsJson, requestId, idempotencyKey, attempts, status, lastError " +
                    "FROM pending_control_actions WHERE id = 'control-1'",
            ).use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertEquals("provider:interrupt", cursor.getString(0))
                assertEquals("[\"thread\"]", cursor.getString(1))
                assertEquals("request-1", cursor.getString(2))
                assertEquals("idem-1", cursor.getString(3))
                assertEquals(1, cursor.getInt(4))
                assertEquals("pending", cursor.getString(5))
                assertEquals("retry", cursor.getString(6))
            }
            migrated.query(
                "SELECT sourceFingerprint, nativeFingerprint, state FROM migration_checkpoint " +
                    "WHERE id = 1",
            ).use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertEquals("source", cursor.getString(0))
                assertEquals("native", cursor.getString(1))
                assertEquals("complete", cursor.getString(2))
            }
            migrated.query(
                "SELECT code, recordKey, detail, severity FROM quarantined_records " +
                    "WHERE sourceKey = 'legacy-key'",
            ).use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertEquals("invalid", cursor.getString(0))
                assertEquals("record", cursor.getString(1))
                assertEquals("keep detail", cursor.getString(2))
                assertEquals("warning", cursor.getString(3))
            }
            migrated.query("SELECT COUNT(*) FROM draft_attachments").use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertEquals(0, cursor.getInt(0))
            }
            migrated.query("SELECT COUNT(*) FROM browse_snapshots").use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertEquals(0, cursor.getInt(0))
            }
            migrated.query("PRAGMA foreign_key_check").use { cursor ->
                assertFalse("Migration left broken foreign keys", cursor.moveToFirst())
            }
            migrated.query("PRAGMA integrity_check").use { cursor ->
                assertTrue(cursor.moveToFirst())
                assertEquals("ok", cursor.getString(0))
                assertFalse(cursor.moveToNext())
            }
        }
    }

    private fun pendingOutbox(
        origin: String,
        attempts: Int = 0,
        legacyRawJson: String? = null,
    ) = OutboxEntity(
        origin = origin,
        bubbleId = "remote_$origin",
        connectionId = "lan",
        threadId = "t",
        text = "queued",
        runtimeMode = null,
        createdAtMs = 9,
        attempts = attempts,
        nextAttemptAtMs = 9,
        deliveryState = "pending",
        stateReason = null,
        receiptLegacy = null,
        receiptDuplicate = null,
        receiptRawJson = null,
        legacyRawJson = legacyRawJson,
    )
}
