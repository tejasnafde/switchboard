package app.switchboard.mobile.ui.pairing

import app.switchboard.mobile.domain.connection.PairingUrl
import java.io.Serializable

data class PairingForm(
    val label: String = "",
    val address: String = "",
    val token: String = "",
) : Serializable

enum class PairingField : Serializable {
    ADDRESS,
}

data class PairingSubmission(
    val label: String,
    val url: String,
    val token: String? = null,
    val pairing: String? = null,
) : Serializable

sealed interface PairingValidation : Serializable {
    data class Valid(val submission: PairingSubmission) : PairingValidation

    data class Invalid(
        val field: PairingField,
        val message: String,
    ) : PairingValidation
}

sealed interface PairingSaveIntent : Serializable {
    val submission: PairingSubmission

    data class Add(
        override val submission: PairingSubmission,
    ) : PairingSaveIntent

    data class Edit(
        val connectionId: String,
        override val submission: PairingSubmission,
        val resetSession: Boolean,
        val reconnect: Boolean,
    ) : PairingSaveIntent
}

sealed interface PairingSaveResult : Serializable {
    data object Success : PairingSaveResult

    data class Failure(val message: String) : PairingSaveResult
}

sealed interface PairingSaveState {
    data object Idle : PairingSaveState

    data class Saving(val intent: PairingSaveIntent) : PairingSaveState

    data class Failed(val message: String) : PairingSaveState

    data class Saved(val intent: PairingSaveIntent) : PairingSaveState
}

sealed interface PairingSaveEvent {
    data class Submit(val intent: PairingSaveIntent) : PairingSaveEvent

    data class Completed(val result: PairingSaveResult) : PairingSaveEvent
}

object PairingSaveReducer {
    fun reduce(state: PairingSaveState, event: PairingSaveEvent): PairingSaveState = when (event) {
        is PairingSaveEvent.Submit -> {
            if (state is PairingSaveState.Saving) state else PairingSaveState.Saving(event.intent)
        }

        is PairingSaveEvent.Completed -> {
            if (state !is PairingSaveState.Saving) {
                state
            } else {
                when (val result = event.result) {
                    PairingSaveResult.Success -> PairingSaveState.Saved(state.intent)
                    is PairingSaveResult.Failure -> PairingSaveState.Failed(result.message)
                }
            }
        }
    }
}

object PairingFormPolicy {
    private const val ADDRESS_ERROR = "Enter a ws:// or wss:// machine address"

    fun validate(form: PairingForm): PairingValidation {
        val parsed = PairingUrl.parse(form.address)
            ?: return PairingValidation.Invalid(PairingField.ADDRESS, ADDRESS_ERROR)
        val typedToken = form.token.trim().ifEmpty { null }
        return PairingValidation.Valid(
            PairingSubmission(
                label = form.label.trim().ifEmpty { parsed.endpoint.removeWebSocketScheme() },
                url = parsed.endpoint,
                token = if (parsed.pairingCode != null) null else parsed.token ?: typedToken,
                pairing = parsed.pairingCode,
            ),
        )
    }

    fun intent(form: PairingForm, editConnectionId: String?): PairingSaveIntent? {
        val submission = (validate(form) as? PairingValidation.Valid)?.submission ?: return null
        return if (editConnectionId == null) {
            PairingSaveIntent.Add(submission)
        } else {
            PairingSaveIntent.Edit(
                connectionId = editConnectionId,
                submission = submission,
                resetSession = true,
                reconnect = true,
            )
        }
    }

    private fun String.removeWebSocketScheme(): String =
        removePrefix("ws://").removePrefix("wss://")
}
