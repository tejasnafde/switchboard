package app.switchboard.mobile.platform.protocol

import app.switchboard.mobile.data.local.PendingControlActionEntity
import app.switchboard.mobile.data.local.ReplayStateEntity
import app.switchboard.mobile.data.local.SyncStateDao
import app.switchboard.mobile.protocol.ResumeCursor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RoomResumeCursorStoreTest {
    @Test
    fun loadPreservesExactEpochAndMapsOnlyThePrivateSentinelBackToNull() {
        val dao = FakeSyncStateDao(
            ReplayStateEntity("numeric", "epoch-a", 42),
            ReplayStateEntity("none", null, RoomResumeCursorStore.NULL_SEQUENCE_SENTINEL),
        )
        val transactions = FakeTransactions()
        dao.transactions = transactions
        val store = RoomResumeCursorStore(dao, transactions)

        assertEquals(ResumeCursor("epoch-a", 42), store.load("numeric"))
        assertEquals(ResumeCursor(null, null), store.load("none"))
        assertEquals(null, store.load("missing"))
    }

    @Test
    fun sameEpochNeverRegressesOrErasesANumericSequence() {
        val dao = FakeSyncStateDao(ReplayStateEntity("machine", "epoch", 10))
        val transactions = FakeTransactions()
        dao.transactions = transactions
        val store = RoomResumeCursorStore(dao, transactions)

        store.save("machine", ResumeCursor("epoch", 9))
        store.save("machine", ResumeCursor("epoch", null))
        store.save("machine", ResumeCursor("epoch", 10))

        assertEquals(ReplayStateEntity("machine", "epoch", 10), dao.rows.getValue("machine"))
        assertTrue(dao.upserts.isEmpty())
        assertEquals(3, transactions.completed)
    }

    @Test
    fun newerSequenceAndEpochReplacementCommitInsideTheTransaction() {
        val dao = FakeSyncStateDao(ReplayStateEntity("machine", "old", 100))
        val transactions = FakeTransactions()
        dao.transactions = transactions
        val store = RoomResumeCursorStore(dao, transactions)

        store.save("machine", ResumeCursor("old", 101))
        store.save("machine", ResumeCursor("new", 1))
        store.save("new-machine", ResumeCursor(null, null))

        assertEquals(
            listOf(
                ReplayStateEntity("machine", "old", 101),
                ReplayStateEntity("machine", "new", 1),
                ReplayStateEntity("new-machine", null, RoomResumeCursorStore.NULL_SEQUENCE_SENTINEL),
            ),
            dao.upserts,
        )
        assertTrue(dao.accessOutsideTransaction.not())
        assertEquals(3, transactions.completed)
    }

    private class FakeTransactions : SynchronousTransactionRunner {
        var depth = 0
        var completed = 0

        override fun <T> run(block: () -> T): T {
            depth++
            return try {
                block()
            } finally {
                depth--
                completed++
            }
        }
    }

    private class FakeSyncStateDao(
        vararg initial: ReplayStateEntity,
    ) : SyncStateDao {
        val rows = initial.associateByTo(linkedMapOf(), ReplayStateEntity::connectionId)
        val upserts = mutableListOf<ReplayStateEntity>()
        var accessOutsideTransaction = false
        var transactions: FakeTransactions? = null

        override fun upsertReplayState(state: ReplayStateEntity) {
            if (transactions?.depth == 0) accessOutsideTransaction = true
            rows[state.connectionId] = state
            upserts += state
        }

        override fun upsertPendingAction(action: PendingControlActionEntity) = Unit

        override fun allReplayStates(): List<ReplayStateEntity> {
            if (transactions?.depth == 0) accessOutsideTransaction = true
            return rows.values.toList()
        }

        override fun allPendingActions(): List<PendingControlActionEntity> = emptyList()
        override fun pendingActions(): List<PendingControlActionEntity> = emptyList()
    }
}
