package app.switchboard.mobile.domain.thread

import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonValue
import app.switchboard.mobile.protocol.longOrNull
import app.switchboard.mobile.protocol.stringOrNull

/**
 * Auto-resume after a usage limit: what a chat's Limited row shows. Port of
 * `LimitState`, `limitStateText` and `limitStateDetail` in
 * src/shared/limit-resume.ts, checked against tests/fixtures/limit-resume-cases.json.
 */
const val LIMIT_AUTO_RESUME_CAPABILITY = "limit_auto_resume_v1"

private const val LIMIT_RESUME_MAX_STREAK = 3

sealed interface LimitState {
    data object None : LimitState
    data class Armed(val resetAt: Long) : LimitState
    data object Disarmed : LimitState
    data object GaveUp : LimitState
    data object NoReset : LimitState
}

/** `provider:limit-resume-resume-now` answer. */
sealed interface LimitResumeNowResult {
    data object Ok : LimitResumeNowResult
    data class Refused(val message: String) : LimitResumeNowResult
}

object LimitResume {
    /** `provider:limit-resume-get` answer. A kind this build does not know shows no row. */
    fun decode(value: JsonValue?): LimitState {
        val raw = value as? JsonObject ?: return LimitState.None
        return when (raw.stringOrNull("kind")) {
            "armed" -> raw.longOrNull("resetAt")?.let(LimitState::Armed) ?: LimitState.NoReset
            "disarmed" -> LimitState.Disarmed
            "gave_up" -> LimitState.GaveUp
            "no_reset" -> LimitState.NoReset
            else -> LimitState.None
        }
    }

    /** The row's title. [formatTime] turns epoch ms into "15:40". */
    fun text(state: LimitState, formatTime: (Long) -> String): String? = when (state) {
        LimitState.None -> null
        is LimitState.Armed -> "Usage limit. Resumes ${formatTime(state.resetAt)}."
        LimitState.Disarmed -> "Usage limit. Auto-resume off."
        LimitState.GaveUp -> "Usage limit. Gave up after $LIMIT_RESUME_MAX_STREAK tries."
        LimitState.NoReset -> "Usage limit. No reset time, resume by hand."
    }

    /** The line under the title: what happens next. */
    fun detail(state: LimitState): String? = when (state) {
        LimitState.None -> null
        is LimitState.Armed -> "This chat carries on by itself then. A message you send now runs at once."
        LimitState.Disarmed, LimitState.GaveUp -> "Send a message after the reset to continue."
        LimitState.NoReset -> "Send a message to try again. It fails while the limit lasts."
    }
}
