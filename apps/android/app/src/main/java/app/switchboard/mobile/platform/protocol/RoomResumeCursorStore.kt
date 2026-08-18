package app.switchboard.mobile.platform.protocol

import app.switchboard.mobile.data.local.ReplayStateEntity
import app.switchboard.mobile.data.local.SwitchboardDatabase
import app.switchboard.mobile.data.local.SyncStateDao
import app.switchboard.mobile.protocol.ResumeCursor
import java.util.concurrent.Callable

interface SynchronousTransactionRunner {
    fun <T> run(block: () -> T): T
}

class RoomResumeCursorStore(
    private val dao: SyncStateDao,
    private val transactions: SynchronousTransactionRunner,
) : ResumeCursorStore {
    constructor(database: SwitchboardDatabase) : this(
        dao = database.syncStateDao(),
        transactions = object : SynchronousTransactionRunner {
            override fun <T> run(block: () -> T): T =
                database.runInTransaction(Callable(block))
        },
    )

    override fun load(connectionId: String): ResumeCursor? = transactions.run {
        dao.allReplayStates()
            .firstOrNull { it.connectionId == connectionId }
            ?.toCursor()
    }

    override fun save(connectionId: String, cursor: ResumeCursor) {
        require(cursor.sequence == null || cursor.sequence >= 0) {
            "resume cursor sequence must be non-negative"
        }
        transactions.run {
            val current = dao.allReplayStates().firstOrNull { it.connectionId == connectionId }
            if (current == null || shouldReplace(current.toCursor(), cursor)) {
                dao.upsertReplayState(cursor.toEntity(connectionId))
            }
        }
    }

    private fun shouldReplace(current: ResumeCursor, incoming: ResumeCursor): Boolean {
        if (current.epoch != incoming.epoch) return true
        val currentSequence = current.sequence
        val incomingSequence = incoming.sequence
        if (incomingSequence == null) return false
        return currentSequence == null || incomingSequence > currentSequence
    }

    private fun ReplayStateEntity.toCursor() = ResumeCursor(
        epoch = epoch,
        sequence = lastSequence.takeUnless { it == NULL_SEQUENCE_SENTINEL },
    )

    private fun ResumeCursor.toEntity(connectionId: String) = ReplayStateEntity(
        connectionId = connectionId,
        epoch = epoch,
        lastSequence = sequence ?: NULL_SEQUENCE_SENTINEL,
    )

    companion object {
        internal const val NULL_SEQUENCE_SENTINEL = Long.MIN_VALUE
    }
}
