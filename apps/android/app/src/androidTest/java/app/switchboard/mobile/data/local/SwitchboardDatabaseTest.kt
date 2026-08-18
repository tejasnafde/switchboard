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
