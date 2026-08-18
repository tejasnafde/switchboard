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

    @Test
    fun validatesAndNormalizesManualIapCreation() {
        val form = PairingForm(
            kind = PairingConnectionKind.IAP,
            label = " ",
            project = " work-project ",
            zone = " asia-south1-b ",
            instance = " work-vm ",
            port = "8766",
            token = " backend-secret ",
        )

        val intent = PairingFormPolicy.intent(form, editConnectionId = null)

        assertEquals(
            PairingSaveIntent.Add(
                PairingSubmission(
                    label = "work-vm",
                    kind = PairingConnectionKind.IAP,
                    project = "work-project",
                    zone = "asia-south1-b",
                    instance = "work-vm",
                    port = 8766,
                    token = "backend-secret",
                ),
            ),
            intent,
        )
    }

    @Test
    fun manualIapCreationRequiresEveryTargetFieldValidTcpPortAndBackendToken() {
        val base = PairingForm(
            kind = PairingConnectionKind.IAP,
            project = "project",
            zone = "zone",
            instance = "vm",
            port = "8766",
            token = "secret",
        )

        assertEquals(PairingField.PROJECT, invalidField(base.copy(project = "")))
        assertEquals(PairingField.ZONE, invalidField(base.copy(zone = "")))
        assertEquals(PairingField.INSTANCE, invalidField(base.copy(instance = "")))
        assertEquals(PairingField.PORT, invalidField(base.copy(port = "0")))
        assertEquals(PairingField.PORT, invalidField(base.copy(port = "65536")))
        assertEquals(PairingField.PORT, invalidField(base.copy(port = "not-a-port")))
        assertEquals(PairingField.TOKEN, invalidField(base.copy(token = "")))
    }

    @Test
    fun manualIapEditMayLeaveTokenBlankToPreserveEncryptedCredential() {
        val intent = PairingFormPolicy.intent(
            PairingForm(
                kind = PairingConnectionKind.IAP,
                label = "Work VM",
                project = "project",
                zone = "zone",
                instance = "vm",
                port = "8766",
            ),
            editConnectionId = "iap-1",
        )

        assertEquals(
            PairingSaveIntent.Edit(
                connectionId = "iap-1",
                submission = PairingSubmission(
                    label = "Work VM",
                    kind = PairingConnectionKind.IAP,
                    project = "project",
                    zone = "zone",
                    instance = "vm",
                    port = 8766,
                ),
                resetSession = true,
                reconnect = true,
            ),
            intent,
        )
    }

    @Test
    fun googlePrerequisiteRequestsAccountBeforeSavingIap() {
        assertEquals(
            IapPrerequisiteAction.REQUEST_GOOGLE_ACCOUNT,
            IapGooglePrerequisitePolicy.submitAction(
                googleAccountReady = false,
                editing = false,
            ),
        )
        assertEquals(
            IapPrerequisiteAction.SAVE,
            IapGooglePrerequisitePolicy.submitAction(
                googleAccountReady = true,
                editing = false,
            ),
        )
        assertEquals(
            IapPrerequisiteAction.SAVE,
            IapGooglePrerequisitePolicy.submitAction(
                googleAccountReady = false,
                editing = true,
            ),
        )
    }

    private fun invalidField(form: PairingForm): PairingField =
        (PairingFormPolicy.validate(form) as PairingValidation.Invalid).field
}
