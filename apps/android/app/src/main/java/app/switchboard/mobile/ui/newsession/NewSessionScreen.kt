package app.switchboard.mobile.ui.newsession

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
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
    Column(
        modifier = modifier
            .fillMaxSize()
            .background(Surface),
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
                modifier = Modifier.padding(start = 8.dp),
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
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(bottom = 8.dp)
                        .background(
                            if (selected) Accent.copy(alpha = 0.14f) else SurfaceRaised,
                            RoundedCornerShape(12.dp),
                        )
                        .clickable(enabled = !state.submitting && !state.launchLocked) {
                            onProvider(provider.kind)
                        }
                        .padding(horizontal = 16.dp, vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(provider.label, style = MaterialTheme.typography.titleSmall)
                        Text(
                            text = when (provider.kind) {
                                ProviderKind.Claude -> "Anthropic agent SDK"
                                ProviderKind.Codex -> "OpenAI app-server"
                                ProviderKind.OpenCode -> "Agent Client Protocol"
                            },
                            color = TextDim,
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                    Text(if (selected) "●" else "○", color = if (selected) Accent else TextDim)
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
                onValueChange = onFirstMessage,
                minLines = 4,
                enabled = !state.submitting && !state.launchLocked,
                placeholder = { Text("What should the agent work on?") },
                modifier = Modifier.fillMaxWidth(),
            )
            state.error?.let { message ->
                Text(
                    text = message,
                    color = Red,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(top = 12.dp),
                )
            }
            Button(
                onClick = onStart,
                enabled = !state.submitting && !state.loadingDefaults,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 52.dp)
                    .padding(top = 20.dp),
            ) {
                if (state.submitting) {
                    CircularProgressIndicator(strokeWidth = 2.dp)
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
        modifier = Modifier.padding(top = 22.dp, bottom = 10.dp),
    )
}

@Composable
private fun ChoiceButton(
    label: String,
    selected: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    if (selected) {
        Button(onClick = onClick, enabled = enabled) { Text(label, maxLines = 1) }
    } else {
        OutlinedButton(onClick = onClick, enabled = enabled) { Text(label, maxLines = 1) }
    }
}

@Composable
private fun LoadingRow(label: String) {
    Row(
        modifier = Modifier.padding(top = 18.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CircularProgressIndicator(strokeWidth = 2.dp)
        Text(label, color = TextDim, modifier = Modifier.padding(start = 12.dp))
    }
}
