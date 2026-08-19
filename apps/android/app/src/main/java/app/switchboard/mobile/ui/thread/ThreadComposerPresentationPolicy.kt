package app.switchboard.mobile.ui.thread

import app.switchboard.mobile.domain.remote.RuntimeMode

enum class ThreadComposerDensity {
    Compact,
    Expanded,
}

data class ThreadSettingsAffordance(
    val label: String,
    val supportingLabel: String,
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
        label = modelLabel?.trim()?.takeIf(String::isNotEmpty) ?: "Model & runtime",
        supportingLabel = runtimeMode.presentationLabel(),
    )

    fun showsSecondaryActions(density: ThreadComposerDensity): Boolean =
        density == ThreadComposerDensity.Expanded
}

internal fun RuntimeMode.presentationLabel(): String = when (this) {
    RuntimeMode.Plan -> "Plan"
    RuntimeMode.Sandbox -> "Sandbox"
    RuntimeMode.AcceptEdits -> "Accept edits"
    RuntimeMode.FullAccess -> "Full access"
}
