package app.switchboard.mobile.ui.pairing

sealed interface PairingQrState {
    val latched: Boolean

    data class Scanning(
        val message: String? = null,
        override val latched: Boolean = false,
    ) : PairingQrState

    data class ReadyToSave(
        val rawPayload: String,
        val submission: PairingSubmission,
        override val latched: Boolean = true,
    ) : PairingQrState

    data object Saved : PairingQrState {
        override val latched: Boolean = true
    }
}

sealed interface PairingQrEvent {
    data class Detected(val rawPayload: String) : PairingQrEvent

    data class SaveCompleted(val result: PairingSaveResult) : PairingQrEvent
}

object PairingQrReducer {
    fun reduce(state: PairingQrState, event: PairingQrEvent): PairingQrState = when (event) {
        is PairingQrEvent.Detected -> {
            if (state.latched) {
                state
            } else {
                val rawPayload = event.rawPayload.trim()
                val valid = PairingFormPolicy.validate(PairingForm(address = rawPayload))
                    as? PairingValidation.Valid
                if (valid == null) {
                    PairingQrState.Scanning(
                        message = "That QR is not a Switchboard machine address",
                    )
                } else {
                    PairingQrState.ReadyToSave(rawPayload, valid.submission)
                }
            }
        }

        is PairingQrEvent.SaveCompleted -> {
            if (state !is PairingQrState.ReadyToSave) {
                state
            } else {
                when (val result = event.result) {
                    PairingSaveResult.Success -> PairingQrState.Saved
                    is PairingSaveResult.Failure -> PairingQrState.Scanning(result.message)
                }
            }
        }
    }
}
