package app.switchboard.mobile.platform.migration

sealed interface SelectedCredential {
    val value: String?

    sealed interface Present : SelectedCredential {
        override val value: String
    }

    data class DeviceSession(override val value: String) : Present
    data class PairingToken(override val value: String) : Present
    data class LegacyInlineToken(override val value: String) : Present
    data object Missing : SelectedCredential {
        override val value: String? = null
    }
    data class Blocked(
        val failure: LegacySecureValue.Failure,
    ) : SelectedCredential {
        override val value: String? = null
    }
}

object CredentialPrecedence {
    fun select(
        session: LegacySecureValue,
        pairing: LegacySecureValue,
        inlineToken: String?,
    ): SelectedCredential = when (session) {
        is LegacySecureValue.Found -> SelectedCredential.DeviceSession(session.value)
        is LegacySecureValue.Failure -> SelectedCredential.Blocked(session)
        LegacySecureValue.Missing -> when (pairing) {
            is LegacySecureValue.Found -> SelectedCredential.PairingToken(pairing.value)
            is LegacySecureValue.Failure -> SelectedCredential.Blocked(pairing)
            LegacySecureValue.Missing -> inlineToken?.let(SelectedCredential::LegacyInlineToken)
                ?: SelectedCredential.Missing
        }
    }
}
