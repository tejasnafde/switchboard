package app.switchboard.mobile.ui.thread

import app.switchboard.mobile.domain.remote.RuntimeMode

enum class ThreadComposerDensity {
    Compact,
    Expanded,
}

data class ThreadComposerInputLayout(
    val singleLine: Boolean,
    val maxLines: Int,
)

data class ThreadSettingsAffordance(
    /** "claude-opus-5-5 · Full access": the model and the mode on one chip. */
    val label: String,
)

object ThreadComposerPresentationPolicy {
    fun density(
        focused: Boolean,
        hasAttachments: Boolean,
        hasTransientContent: Boolean,
    ): ThreadComposerDensity = if (focused || hasAttachments || hasTransientContent) {
        ThreadComposerDensity.Expanded
    } else {
        ThreadComposerDensity.Compact
    }

    fun settingsAffordance(
        modelLabel: String?,
        runtimeMode: RuntimeMode,
    ): ThreadSettingsAffordance = ThreadSettingsAffordance(
        label = "${modelLabel?.trim()?.takeIf(String::isNotEmpty) ?: "Model"} · ${runtimeMode.presentationLabel()}",
    )

    /** The footer row: shown while focused or while a turn runs (it holds the Steer | Queue segment). */
    fun showsSecondaryActions(density: ThreadComposerDensity, running: Boolean): Boolean =
        density == ThreadComposerDensity.Expanded || running

    fun inputLayout(density: ThreadComposerDensity): ThreadComposerInputLayout =
        when (density) {
            ThreadComposerDensity.Compact,
            ThreadComposerDensity.Expanded -> ThreadComposerInputLayout(singleLine = false, maxLines = 5)
        }
}

internal fun RuntimeMode.presentationLabel(): String = when (this) {
    RuntimeMode.Plan -> "Plan"
    RuntimeMode.Sandbox -> "Supervised"
    RuntimeMode.AcceptEdits -> "Auto-accept edits"
    RuntimeMode.Auto -> "Auto"
    RuntimeMode.FullAccess -> "Full access"
}
