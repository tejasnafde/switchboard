package app.switchboard.mobile.ui.newsession

import androidx.compose.foundation.background
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.switchboard.mobile.data.remote.NewSessionState
import app.switchboard.mobile.domain.remote.NewSessionDecisions
import app.switchboard.mobile.domain.remote.ProviderKind
import app.switchboard.mobile.domain.remote.RuntimeMode
import app.switchboard.mobile.ui.theme.Accent
import app.switchboard.mobile.ui.theme.Red
import app.switchboard.mobile.ui.theme.Surface
import app.switchboard.mobile.ui.theme.SurfaceRaised
import app.switchboard.mobile.ui.theme.TextDim
import app.switchboard.mobile.ui.voice.NewSessionVoiceControl
import app.switchboard.mobile.ui.voice.VoiceNoticeRow
import app.switchboard.mobile.ui.voice.rememberVoiceComposer

@Composable
fun NewSessionScreen(
    state: NewSessionState,
    onBack: () -> Unit,
    onProvider: (ProviderKind) -> Unit,
    onRuntimeMode: (RuntimeMode) -> Unit,
    onInstance: (String?) -> Unit,
    onModel: (String?) -> Unit,
    onFirstMessage: (String) -> Unit,
    onStart: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val voice = rememberVoiceComposer(
        draft = state.firstMessage,
        onDraft = onFirstMessage,
        projectPath = state.projectPath,
    )
    Column(
        modifier = modifier
            .fillMaxSize()
            .background(Surface)
            .semantics { isTraversalGroup = true },
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .statusBarsPadding()
                .heightIn(min = 56.dp)
                .padding(horizontal = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TextButton(onClick = onBack, modifier = Modifier.heightIn(min = 48.dp)) {
                Text("Back")
            }
            Text(
                text = "New session",
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier
                    .padding(start = 8.dp)
                    .semantics { heading() },
            )
        }
        Column(
            modifier = Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp),
        ) {
            Text(state.projectName, style = MaterialTheme.typography.headlineSmall)
            Text(
                text = state.projectPath,
                color = TextDim,
                style = MaterialTheme.typography.bodySmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 4.dp, bottom = 24.dp),
            )

            SectionLabel("Agent")
            NewSessionDecisions.providers.forEach { provider ->
                val selected = state.provider == provider.kind
                val providerDescription = when (provider.kind) {
                    ProviderKind.Claude -> "Anthropic agent SDK"
                    ProviderKind.Codex -> "OpenAI app-server"
                    ProviderKind.OpenCode -> "Agent Client Protocol"
                }
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(bottom = 8.dp)
                        .background(
                            if (selected) Accent.copy(alpha = 0.14f) else SurfaceRaised,
                            RoundedCornerShape(12.dp),
                        )
                        .semantics(mergeDescendants = true) {
                            contentDescription = "${provider.label}, $providerDescription"
                            stateDescription = NewSessionAccessibilityPolicy.choiceState(selected)
                        }
                        .selectable(
                            selected = selected,
                            enabled = !state.submitting && !state.launchLocked,
                            role = Role.RadioButton,
                            onClick = { onProvider(provider.kind) },
                        )
                        .padding(horizontal = 16.dp, vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(
                        modifier = Modifier
                            .weight(1f)
                            .clearAndSetSemantics {},
                    ) {
                        Text(provider.label, style = MaterialTheme.typography.titleSmall)
                        Text(
                            text = providerDescription,
                            color = TextDim,
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                    Text(
                        if (selected) "●" else "○",
                        color = if (selected) Accent else TextDim,
                        modifier = Modifier.clearAndSetSemantics {},
                    )
                }
            }

            if (state.loadingInstances) {
                LoadingRow("Loading profiles")
            } else if (state.profiles.isNotEmpty()) {
                SectionLabel("Profile")
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    state.profiles.forEach { profile ->
                        ChoiceButton(
                            label = profile.displayName,
                            selected = profile.id == state.selectedInstanceId,
                            enabled = !state.submitting && !state.launchLocked,
                            onClick = { onInstance(profile.id) },
                        )
                    }
                }
            }

            SectionLabel("Model")
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                ChoiceButton(
                    label = "Backend default",
                    selected = state.selectedModelId == null,
                    enabled = !state.submitting && !state.launchLocked,
                    onClick = { onModel(null) },
                )
                state.modelOptions.forEach { model ->
                    ChoiceButton(
                        label = model.label,
                        selected = model.id == state.selectedModelId,
                        enabled = !state.submitting && !state.launchLocked,
                        onClick = { onModel(model.id) },
                    )
                }
            }

            SectionLabel("Permissions")
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                RuntimeMode.entries.forEach { mode ->
                    ChoiceButton(
                        label = when (mode) {
                            RuntimeMode.Plan -> "Plan"
                            RuntimeMode.Sandbox -> "Sandbox"
                            RuntimeMode.AcceptEdits -> "Accept edits"
                            RuntimeMode.FullAccess -> "Full access"
                        },
                        selected = state.runtimeMode == mode,
                        enabled = !state.submitting && !state.launchLocked,
                        onClick = { onRuntimeMode(mode) },
                    )
                }
            }

            SectionLabel("First message (optional)")
            OutlinedTextField(
                value = state.firstMessage,
                onValueChange = { text ->
                    voice.userEdited(text)
                    onFirstMessage(text)
                },
                minLines = 4,
                enabled = !state.submitting && !state.launchLocked,
                placeholder = { Text("What should the agent work on?") },
                modifier = Modifier
                    .fillMaxWidth()
                    .semantics { contentDescription = "First message" },
            )
            NewSessionVoiceControl(
                voice = voice,
                enabled = !state.submitting && !state.launchLocked,
                modifier = Modifier.padding(top = 8.dp),
            )
            VoiceNoticeRow(voice = voice)
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 32.dp),
            ) {
                state.error?.let { message ->
                    Text(
                        text = message,
                        color = Red,
                        style = MaterialTheme.typography.bodySmall,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier
                            .padding(top = 10.dp)
                            .semantics {
                                liveRegion = LiveRegionMode.Polite
                                error(message)
                            },
                    )
                }
            }
            Button(
                onClick = onStart,
                enabled = !state.submitting && !state.loadingDefaults,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 52.dp)
                    .padding(top = 20.dp)
                    .semantics {
                        contentDescription = NewSessionAccessibilityPolicy.launchState(state.submitting)
                        stateDescription = if (state.submitting) "In progress" else "Ready"
                    },
            ) {
                if (state.submitting) {
                    CircularProgressIndicator(
                        strokeWidth = 2.dp,
                        modifier = Modifier
                            .size(18.dp)
                            .clearAndSetSemantics {},
                    )
                } else {
                    Text("Start session")
                }
            }
            Spacer(Modifier.navigationBarsPadding())
        }
    }
}

@Composable
private fun SectionLabel(label: String) {
    Text(
        text = label,
        color = TextDim,
        style = MaterialTheme.typography.labelLarge,
        modifier = Modifier
            .padding(top = 22.dp, bottom = 10.dp)
            .semantics { heading() },
    )
}

@Composable
private fun ChoiceButton(
    label: String,
    selected: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    val semantics = Modifier
        .heightIn(min = 48.dp)
        .semantics {
            role = Role.RadioButton
            this.selected = selected
            stateDescription = NewSessionAccessibilityPolicy.choiceState(selected)
        }
    if (selected) {
        Button(onClick = onClick, enabled = enabled, modifier = semantics) { Text(label, maxLines = 1) }
    } else {
        OutlinedButton(onClick = onClick, enabled = enabled, modifier = semantics) {
            Text(label, maxLines = 1)
        }
    }
}

@Composable
private fun LoadingRow(label: String) {
    Row(
        modifier = Modifier
            .padding(top = 18.dp)
            .heightIn(min = 48.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
        Text(label, color = TextDim, modifier = Modifier.padding(start = 12.dp))
    }
}

object NewSessionAccessibilityPolicy {
    fun choiceState(selected: Boolean): String = if (selected) "Selected" else "Not selected"

    fun launchState(submitting: Boolean): String = if (submitting) "Starting session" else "Start session"
}
