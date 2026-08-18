package app.switchboard.mobile.ui.pairing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingSaveReducerTest {
    private val intent = PairingSaveIntent.Add(
        PairingSubmission(label = "Studio", url = "ws://machine:8765"),
    )

    @Test
    fun submitEntersSavingAndRepeatedSubmitCannotStartAnotherWrite() {
        val saving = PairingSaveReducer.reduce(
            PairingSaveState.Idle,
            PairingSaveEvent.Submit(intent),
        )

        assertEquals(PairingSaveState.Saving(intent), saving)
        assertSame(saving, PairingSaveReducer.reduce(saving, PairingSaveEvent.Submit(intent)))
    }

    @Test
    fun onlyAConfirmedDurableSuccessCompletesTheFlow() {
        val saving = PairingSaveState.Saving(intent)

        assertEquals(
            PairingSaveState.Failed("Could not save securely"),
            PairingSaveReducer.reduce(
                saving,
                PairingSaveEvent.Completed(PairingSaveResult.Failure("Could not save securely")),
            ),
        )
        assertTrue(
            PairingSaveReducer.reduce(
                saving,
                PairingSaveEvent.Completed(PairingSaveResult.Success),
            ) is PairingSaveState.Saved,
        )
    }

    @Test
    fun staleCompletionCannotDismissAnIdleOrFailedForm() {
        val completion = PairingSaveEvent.Completed(PairingSaveResult.Success)
        val failed = PairingSaveState.Failed("Still here")

        assertSame(PairingSaveState.Idle, PairingSaveReducer.reduce(PairingSaveState.Idle, completion))
        assertSame(failed, PairingSaveReducer.reduce(failed, completion))
    }
}
