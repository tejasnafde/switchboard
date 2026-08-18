package app.switchboard.mobile.ui.pairing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingQrReducerTest {
    @Test
    fun unrelatedQrDoesNotLatchTheScanner() {
        val state = PairingQrReducer.reduce(
            PairingQrState.Scanning(),
            PairingQrEvent.Detected("https://example.test/not-switchboard"),
        )

        assertTrue(state is PairingQrState.Scanning)
        assertEquals(
            "That QR is not a Switchboard machine address",
            (state as PairingQrState.Scanning).message,
        )
        assertFalse(state.latched)
    }

    @Test
    fun validPayloadUsesTheCanonicalPairingParserAndLatchesUntilSaveCompletes() {
        val state = PairingQrReducer.reduce(
            PairingQrState.Scanning(),
            PairingQrEvent.Detected(
                "  ws://studio.local:8765/socket?token=legacy&pair=one-time  ",
            ),
        )

        assertTrue(state is PairingQrState.ReadyToSave)
        state as PairingQrState.ReadyToSave
        assertEquals("studio.local:8765/socket", state.submission.label)
        assertEquals("ws://studio.local:8765/socket", state.submission.url)
        assertEquals("one-time", state.submission.pairing)
        assertNull(state.submission.token)
        assertTrue(state.latched)

        assertSame(
            state,
            PairingQrReducer.reduce(state, PairingQrEvent.Detected("ws://other:8765")),
        )
    }

    @Test
    fun failedSaveUnlatchesAndSuccessFinishesExactlyOnce() {
        val ready = PairingQrReducer.reduce(
            PairingQrState.Scanning(),
            PairingQrEvent.Detected("wss://studio.example/ws?pair=once"),
        ) as PairingQrState.ReadyToSave

        assertEquals(
            PairingQrState.Scanning(message = "Secure storage unavailable"),
            PairingQrReducer.reduce(
                ready,
                PairingQrEvent.SaveCompleted(PairingSaveResult.Failure("Secure storage unavailable")),
            ),
        )

        val saved = PairingQrReducer.reduce(
            ready,
            PairingQrEvent.SaveCompleted(PairingSaveResult.Success),
        )
        assertTrue(saved is PairingQrState.Saved)
        assertSame(saved, PairingQrReducer.reduce(saved, PairingQrEvent.SaveCompleted(PairingSaveResult.Success)))
    }
}
