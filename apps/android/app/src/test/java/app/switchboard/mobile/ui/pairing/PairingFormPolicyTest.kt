package app.switchboard.mobile.ui.pairing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingFormPolicyTest {
    @Test
    fun validatesWebSocketAddressesAndDefaultsTheLabelToTheTarget() {
        assertEquals(
            PairingValidation.Invalid(PairingField.ADDRESS, "Enter a ws:// or wss:// machine address"),
            PairingFormPolicy.validate(PairingForm(address = "https://example.test")),
        )

        val valid = PairingFormPolicy.validate(
            PairingForm(address = " ws://192.168.1.8:8765/ "),
        ) as PairingValidation.Valid
        assertEquals("ws://192.168.1.8:8765", valid.submission.url)
        assertEquals("192.168.1.8:8765", valid.submission.label)
    }

    @Test
    fun pairingCodeInTheAddressWinsOverLegacyAndTypedTokens() {
        val valid = PairingFormPolicy.validate(
            PairingForm(
                label = "Studio",
                address = "ws://machine.local:8765?token=legacy&pair=one-time",
                token = "typed-token",
            ),
        ) as PairingValidation.Valid

        assertEquals("one-time", valid.submission.pairing)
        assertNull(valid.submission.token)
        assertEquals("ws://machine.local:8765", valid.submission.url)
    }

    @Test
    fun encodedPathsRemainByteForByteCompatibleWithTheDomainParser() {
        val valid = PairingFormPolicy.validate(
            PairingForm(address = "wss://machine.example/sessions%2Factive?token=secret"),
        ) as PairingValidation.Valid

        assertEquals("wss://machine.example/sessions%2Factive", valid.submission.url)
        assertEquals("secret", valid.submission.token)
    }

    @Test
    fun emitsDifferentImmutableIntentsForAddAndEdit() {
        val form = PairingForm(label = "Studio", address = "wss://machine.example/ws", token = "secret")
        val add = PairingFormPolicy.intent(form, editConnectionId = null)
        val edit = PairingFormPolicy.intent(form, editConnectionId = "machine-1")

        assertTrue(add is PairingSaveIntent.Add)
        assertEquals(
            PairingSaveIntent.Edit(
                connectionId = "machine-1",
                submission = (add as PairingSaveIntent.Add).submission,
                resetSession = true,
                reconnect = true,
            ),
            edit,
        )
    }
}
