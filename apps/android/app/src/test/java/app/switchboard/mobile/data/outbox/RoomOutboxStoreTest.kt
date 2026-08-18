package app.switchboard.mobile.data.outbox

import app.switchboard.mobile.data.local.OutboxAttachmentEntity
import app.switchboard.mobile.data.local.OutboxDao
import app.switchboard.mobile.data.local.OutboxEntity
import app.switchboard.mobile.data.local.OutboxWithAttachments
import app.switchboard.mobile.domain.outbox.OutboxDeliveryState
import app.switchboard.mobile.domain.outbox.QueuedTurn
import app.switchboard.mobile.domain.outbox.SendReceipt
import app.switchboard.mobile.domain.outbox.StagedAttachment
import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonObject
import java.util.LinkedHashMap
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RoomOutboxStoreTest {
    @Test
    fun allDeliveryStatesAndReceiptsRoundTripLosslessly() {
        val dao = FakeOutboxDao()
        val store = RoomOutboxStore(dao)
        val turns = listOf(
            turn("pending", OutboxDeliveryState.Pending),
            turn(
                "ack",
                OutboxDeliveryState.Acknowledged(
                    SendReceipt(
                        legacy = false,
                        duplicate = true,
                        raw = JsonObject(linkedMapOf("accepted" to JsonBoolean(true))),
                    ),
                ),
            ),
            turn("terminal", OutboxDeliveryState.Terminal("denied")),
            turn("ambiguous", OutboxDeliveryState.Ambiguous("transport closed")),
        )

        turns.forEach { assertEquals(OutboxStorageResult.Success, store.insert(it)) }

        assertEquals(OutboxLoadResult.Success(turns.sortedBy(QueuedTurn::origin)), store.load())
    }

    @Test
    fun acknowledgedStateSurvivesDeleteFailureAndRestartWithoutBecomingPending() {
        val dao = FakeOutboxDao()
        val store = RoomOutboxStore(dao)
        val pending = turn("origin-ack", OutboxDeliveryState.Pending)
        val acknowledged = pending.copy(
            attempts = 2,
            nextAttemptAtMs = 88,
            deliveryState = OutboxDeliveryState.Acknowledged(SendReceipt.legacy()),
        )
        assertEquals(OutboxStorageResult.Success, store.insert(pending))
        assertEquals(OutboxStorageResult.Success, store.update(acknowledged))
        dao.failDeletes = true

        assertTrue(store.delete(pending.origin) is OutboxStorageResult.Failure)

        val afterRestart = RoomOutboxStore(dao).load() as OutboxLoadResult.Success
        assertEquals(listOf(acknowledged), afterRestart.turns)
        assertTrue(afterRestart.turns.single().deliveryState is OutboxDeliveryState.Acknowledged)
    }

    @Test
    fun imageOnlyLegacyPayloadSurvivesHydrationAndRetryUpdateByteForByte() {
        val raw =
            """{"connectionId":"lan","threadId":"thread","messageId":"legacy-image","text":"","images":[{"url":"data:image/png;base64,AQID","mimeType":"image/png"}],"createdAt":7}"""
        val dao = FakeOutboxDao()
        dao.messages["legacy-image"] = OutboxEntityMapper.toRows(
            turn("legacy-image", OutboxDeliveryState.Pending),
        ).message.copy(text = "", legacyRawJson = raw)
        val store = RoomOutboxStore(dao)

        val hydrated = (store.load() as OutboxLoadResult.Success).turns.single()
        assertEquals(raw, hydrated.legacyRawJson)

        assertEquals(
            OutboxStorageResult.Success,
            store.update(hydrated.copy(attempts = 2, nextAttemptAtMs = 1_000)),
        )
        assertEquals(raw, dao.messages.getValue("legacy-image").legacyRawJson)
    }

    @Test
    fun duplicateOriginFailsWithoutReplacingExistingPayloadOrAttachments() {
        val dao = FakeOutboxDao()
        val store = RoomOutboxStore(dao)
        val original = turn("same-origin", OutboxDeliveryState.Pending)
        val replacement = original.copy(text = "must not replace", bubbleId = "different")

        assertEquals(OutboxStorageResult.Success, store.insert(original))
        assertTrue(store.insert(replacement) is OutboxStorageResult.Failure)

        assertEquals(OutboxLoadResult.Success(listOf(original)), store.load())
    }

    @Test
    fun malformedPersistedStateIsAVisibleLoadFailureInsteadOfAResend() {
        val dao = FakeOutboxDao()
        dao.messages["bad"] = OutboxEntity(
            origin = "bad",
            bubbleId = "remote_bad",
            connectionId = "lan",
            threadId = "thread",
            text = "do not resend",
            runtimeMode = null,
            createdAtMs = 4,
            attempts = 0,
            nextAttemptAtMs = 4,
            deliveryState = "future_state",
            stateReason = null,
            receiptLegacy = null,
            receiptDuplicate = null,
            receiptRawJson = null,
            legacyRawJson = null,
        )

        val result = RoomOutboxStore(dao).load()

        assertTrue(result is OutboxLoadResult.Failure)
        assertTrue((result as OutboxLoadResult.Failure).reason.contains("future_state"))
    }

    @Test
    fun attachmentPositionsMustBeContiguousAndBelongToTheirOrigin() {
        val dao = FakeOutboxDao()
        val valid = turn("origin", OutboxDeliveryState.Pending)
        val mapped = OutboxEntityMapper.toRows(valid)
        dao.messages[valid.origin] = mapped.message
        dao.attachments[valid.origin] = mutableListOf(
            OutboxAttachmentEntity(valid.origin, 1, "/private/missing-zero", "image/png"),
        )

        val result = RoomOutboxStore(dao).load()

        assertTrue(result is OutboxLoadResult.Failure)
        assertTrue((result as OutboxLoadResult.Failure).reason.contains("positions"))
    }

    private fun turn(origin: String, state: OutboxDeliveryState) = QueuedTurn(
        connectionId = "lan",
        threadId = "thread",
        origin = origin,
        bubbleId = "remote_$origin",
        text = "hello $origin",
        attachments = listOf(
            StagedAttachment("/private/$origin-one", "image/png"),
            StagedAttachment("/private/$origin-two", null),
        ),
        runtimeMode = "sandbox",
        createdAtMs = 7,
        attempts = 1,
        nextAttemptAtMs = 42,
        deliveryState = state,
    )
}

private class FakeOutboxDao : OutboxDao {
    val messages = linkedMapOf<String, OutboxEntity>()
    val attachments = linkedMapOf<String, MutableList<OutboxAttachmentEntity>>()
    var failDeletes = false

    override fun insertMessage(message: OutboxEntity): Long {
        check(message.origin !in messages) { "duplicate origin" }
        messages[message.origin] = message
        return messages.size.toLong()
    }

    override fun insertAttachments(rows: List<OutboxAttachmentEntity>) {
        rows.forEach { row ->
            check(row.origin in messages) { "missing parent" }
            val stored = attachments.getOrPut(row.origin) { mutableListOf() }
            check(stored.none { it.position == row.position }) { "duplicate attachment" }
            stored += row
        }
    }

    override fun updateMessage(message: OutboxEntity): Int {
        if (message.origin !in messages) return 0
        messages[message.origin] = message
        return 1
    }

    override fun delete(origin: String): Int {
        check(!failDeletes) { "cleanup failed" }
        val removed = messages.remove(origin) ?: return 0
        attachments.remove(removed.origin)
        return 1
    }

    override fun find(origin: String): OutboxEntity? = messages[origin]

    override fun all(): List<OutboxEntity> = messages.values.sortedWith(
        compareBy(OutboxEntity::createdAtMs, OutboxEntity::origin),
    )

    override fun allWithAttachments(): List<OutboxWithAttachments> = all().map { message ->
        OutboxWithAttachments(
            message,
            attachments[message.origin].orEmpty().sortedBy(OutboxAttachmentEntity::position),
        )
    }

    override fun allAttachments(): List<OutboxAttachmentEntity> =
        attachments.values.flatten().sortedWith(compareBy(OutboxAttachmentEntity::origin, OutboxAttachmentEntity::position))

    override fun attachments(origin: String): List<OutboxAttachmentEntity> =
        attachments[origin].orEmpty().sortedBy(OutboxAttachmentEntity::position)
}
