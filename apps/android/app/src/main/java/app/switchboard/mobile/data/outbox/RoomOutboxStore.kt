package app.switchboard.mobile.data.outbox

import app.switchboard.mobile.data.local.OutboxAttachmentEntity
import app.switchboard.mobile.data.local.OutboxDao
import app.switchboard.mobile.data.local.OutboxEntity
import app.switchboard.mobile.data.local.OutboxWithAttachments
import app.switchboard.mobile.domain.outbox.OutboxDeliveryState
import app.switchboard.mobile.domain.outbox.QueuedTurn
import app.switchboard.mobile.domain.outbox.SendReceipt
import app.switchboard.mobile.domain.outbox.StagedAttachment
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonObject

data class OutboxRows(
    val message: OutboxEntity,
    val attachments: List<OutboxAttachmentEntity>,
)

object OutboxEntityMapper {
    fun toRows(turn: QueuedTurn): OutboxRows {
        val state = turn.deliveryState
        val receipt = (state as? OutboxDeliveryState.Acknowledged)?.receipt
        return OutboxRows(
            message = OutboxEntity(
                origin = turn.origin,
                bubbleId = turn.bubbleId,
                connectionId = turn.connectionId,
                threadId = turn.threadId,
                text = turn.text,
                runtimeMode = turn.runtimeMode,
                createdAtMs = turn.createdAtMs,
                attempts = turn.attempts,
                nextAttemptAtMs = turn.nextAttemptAtMs,
                deliveryState = state.label,
                stateReason = when (state) {
                    is OutboxDeliveryState.Terminal -> state.reason
                    is OutboxDeliveryState.Ambiguous -> state.reason
                    else -> null
                },
                receiptLegacy = receipt?.legacy,
                receiptDuplicate = receipt?.duplicate,
                receiptRawJson = receipt?.raw?.let(JsonCodec::encode),
                legacyRawJson = turn.legacyRawJson,
            ),
            attachments = turn.attachments.mapIndexed { position, attachment ->
                OutboxAttachmentEntity(
                    origin = turn.origin,
                    position = position,
                    privatePath = attachment.privateUri,
                    mimeType = attachment.mimeType,
                )
            },
        )
    }

    fun toDomain(rows: OutboxWithAttachments): QueuedTurn {
        val message = rows.message
        require(message.attempts >= 0) { "outbox ${message.origin} has negative attempts" }
        val attachments = rows.attachments.sortedBy(OutboxAttachmentEntity::position)
        require(attachments.all { it.origin == message.origin }) {
            "outbox ${message.origin} contains attachment rows for a different origin"
        }
        require(attachments.map(OutboxAttachmentEntity::position) == attachments.indices.toList()) {
            "outbox ${message.origin} attachment positions are not contiguous"
        }

        val state = when (message.deliveryState) {
            OutboxDeliveryState.Pending.label -> {
                requireNoReceiptOrReason(message)
                OutboxDeliveryState.Pending
            }
            "acknowledged" -> {
                require(message.stateReason == null) {
                    "outbox ${message.origin} acknowledged state contains a terminal reason"
                }
                val legacy = requireNotNull(message.receiptLegacy) {
                    "outbox ${message.origin} acknowledged state is missing receiptLegacy"
                }
                val duplicate = requireNotNull(message.receiptDuplicate) {
                    "outbox ${message.origin} acknowledged state is missing receiptDuplicate"
                }
                val raw = message.receiptRawJson?.let { source ->
                    JsonCodec.parse(source) as? JsonObject
                        ?: error("outbox ${message.origin} receipt is not a JSON object")
                }
                OutboxDeliveryState.Acknowledged(SendReceipt(legacy, duplicate, raw))
            }
            "terminal" -> {
                requireNoReceipt(message)
                OutboxDeliveryState.Terminal(requireReason(message))
            }
            "ambiguous" -> {
                requireNoReceipt(message)
                OutboxDeliveryState.Ambiguous(requireReason(message))
            }
            else -> error("outbox ${message.origin} has unsupported delivery state ${message.deliveryState}")
        }

        return QueuedTurn(
            connectionId = message.connectionId,
            threadId = message.threadId,
            origin = message.origin,
            bubbleId = message.bubbleId,
            text = message.text,
            attachments = attachments.map { StagedAttachment(it.privatePath, it.mimeType) },
            runtimeMode = message.runtimeMode,
            createdAtMs = message.createdAtMs,
            attempts = message.attempts,
            nextAttemptAtMs = message.nextAttemptAtMs,
            deliveryState = state,
            legacyRawJson = message.legacyRawJson,
        )
    }

    private fun requireNoReceiptOrReason(message: OutboxEntity) {
        require(message.stateReason == null) {
            "outbox ${message.origin} pending state contains a reason"
        }
        requireNoReceipt(message)
    }

    private fun requireNoReceipt(message: OutboxEntity) {
        require(
            message.receiptLegacy == null &&
                message.receiptDuplicate == null &&
                message.receiptRawJson == null,
        ) { "outbox ${message.origin} ${message.deliveryState} state contains a receipt" }
    }

    private fun requireReason(message: OutboxEntity): String =
        requireNotNull(message.stateReason?.takeIf(String::isNotBlank)) {
            "outbox ${message.origin} ${message.deliveryState} state is missing a reason"
        }
}

class RoomOutboxStore(
    private val dao: OutboxDao,
) : OutboxStore {
    override fun insert(turn: QueuedTurn): OutboxStorageResult = storageOperation("insert", turn.origin) {
        val rows = OutboxEntityMapper.toRows(turn)
        dao.insert(rows.message, rows.attachments)
    }

    override fun update(turn: QueuedTurn): OutboxStorageResult = storageOperation("update", turn.origin) {
        val rows = OutboxEntityMapper.toRows(turn)
        require(dao.update(rows.message, rows.attachments) == 1) { "outbox ${turn.origin} does not exist" }
    }

    override fun delete(origin: String): OutboxStorageResult = storageOperation("delete", origin) {
        dao.delete(origin)
    }

    override fun load(): OutboxLoadResult = try {
        OutboxLoadResult.Success(dao.allWithAttachments().map(OutboxEntityMapper::toDomain))
    } catch (exception: Exception) {
        OutboxLoadResult.Failure(exception.message ?: "failed to load outbox")
    }

    private inline fun storageOperation(
        operation: String,
        origin: String,
        block: () -> Unit,
    ): OutboxStorageResult = try {
        block()
        OutboxStorageResult.Success
    } catch (exception: Exception) {
        OutboxStorageResult.Failure(
            exception.message ?: "failed to $operation outbox $origin",
        )
    }
}
