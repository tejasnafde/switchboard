package app.switchboard.mobile.ui.pairing

import app.switchboard.mobile.domain.connection.PairingUrl
import app.switchboard.mobile.domain.connection.IapTargetError
import app.switchboard.mobile.domain.connection.IapTargetValidator
import java.io.Serializable

enum class PairingConnectionKind : Serializable {
    WEBSOCKET,
    IAP,
}

data class PairingForm(
    val kind: PairingConnectionKind = PairingConnectionKind.WEBSOCKET,
    val label: String = "",
    val address: String = "",
    val token: String = "",
    val project: String = "",
    val zone: String = "",
    val instance: String = "",
    val port: String = DEFAULT_IAP_PORT.toString(),
) : Serializable

enum class PairingField : Serializable {
    ADDRESS,
    PROJECT,
    ZONE,
    INSTANCE,
    PORT,
    TOKEN,
}

data class PairingSubmission(
    val label: String,
    val url: String = "",
    val token: String? = null,
    val pairing: String? = null,
    val kind: PairingConnectionKind = PairingConnectionKind.WEBSOCKET,
    val project: String? = null,
    val zone: String? = null,
    val instance: String? = null,
    val port: Int? = null,
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

    fun validate(form: PairingForm, editConnectionId: String? = null): PairingValidation =
        when (form.kind) {
            PairingConnectionKind.WEBSOCKET -> validateWebSocket(form)
            PairingConnectionKind.IAP -> validateIap(form, requireToken = editConnectionId == null)
        }

    private fun validateWebSocket(form: PairingForm): PairingValidation {
        val parsed = PairingUrl.parse(form.address)
            ?: return PairingValidation.Invalid(PairingField.ADDRESS, ADDRESS_ERROR)
        val typedToken = form.token.trim().ifEmpty { null }
        return PairingValidation.Valid(
            PairingSubmission(
                label = form.label.trim().ifEmpty { parsed.endpoint.removeWebSocketScheme() },
                url = parsed.endpoint,
                token = if (parsed.pairingCode != null) null else parsed.token ?: typedToken,
                pairing = parsed.pairingCode,
                kind = PairingConnectionKind.WEBSOCKET,
            ),
        )
    }

    private fun validateIap(form: PairingForm, requireToken: Boolean): PairingValidation {
        val target = IapTargetValidator.validate(
            project = form.project,
            zone = form.zone,
            instance = form.instance,
            port = form.port,
        ).getOrElse { error ->
            return when (error) {
                IapTargetError.MissingDetails -> when {
                    form.project.isBlank() -> PairingValidation.Invalid(PairingField.PROJECT, "Project is required")
                    form.zone.isBlank() -> PairingValidation.Invalid(PairingField.ZONE, "Zone is required")
                    else -> PairingValidation.Invalid(PairingField.INSTANCE, "Instance is required")
                }
                IapTargetError.InvalidPort -> PairingValidation.Invalid(
                    PairingField.PORT,
                    "Enter a port from 1 to 65535",
                )
                else -> PairingValidation.Invalid(PairingField.PORT, "Enter a port from 1 to 65535")
            }
        }
        val token = form.token.trim().ifEmpty { null }
        if (requireToken && token == null) {
            return PairingValidation.Invalid(PairingField.TOKEN, "Enter the backend token")
        }
        return PairingValidation.Valid(
            PairingSubmission(
                label = form.label.trim().ifEmpty { target.instance },
                token = token,
                kind = PairingConnectionKind.IAP,
                project = target.project,
                zone = target.zone,
                instance = target.instance,
                port = target.port,
            ),
        )
    }

    fun intent(form: PairingForm, editConnectionId: String?): PairingSaveIntent? {
        val submission = (validate(form, editConnectionId) as? PairingValidation.Valid)?.submission ?: return null
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

enum class IapPrerequisiteAction {
    SAVE,
    REQUEST_GOOGLE_ACCOUNT,
}

object IapGooglePrerequisitePolicy {
    fun submitAction(
        googleAccountReady: Boolean,
        editing: Boolean,
    ): IapPrerequisiteAction =
        if (googleAccountReady || editing) {
            IapPrerequisiteAction.SAVE
        } else {
            IapPrerequisiteAction.REQUEST_GOOGLE_ACCOUNT
        }
}

const val DEFAULT_IAP_PORT = 8766
