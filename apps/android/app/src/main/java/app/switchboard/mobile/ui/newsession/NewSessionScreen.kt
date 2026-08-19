package app.switchboard.mobile.ui.newsession

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.switchboard.mobile.data.remote.NewSessionState
import app.switchboard.mobile.domain.remote.NewSessionDecisions
import app.switchboard.mobile.domain.remote.NewSessionModelOption
import app.switchboard.mobile.domain.remote.ProviderInstance
import app.switchboard.mobile.domain.remote.ProviderKind
import app.switchboard.mobile.domain.remote.RuntimeMode
import app.switchboard.mobile.ui.theme.Red
import app.switchboard.mobile.ui.theme.Surface
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

            val selectorsEnabled = !state.submitting && !state.launchLocked
            CompactSelector(
                label = "Agent",
                value = NewSessionSelectorPolicy.providerLabel(state.provider),
                options = NewSessionDecisions.providers.map {
                    SelectorOption(
                        label = NewSessionSelectorPolicy.providerLabel(it.kind),
                        selected = state.provider == it.kind,
                    ) {
                        onProvider(it.kind)
                    }
                },
                enabled = selectorsEnabled,
            )

            if (state.loadingInstances || state.profiles.isNotEmpty()) {
                CompactSelector(
                    label = "Profile",
                    value = NewSessionSelectorPolicy.profileLabel(
                        state.loadingInstances,
                        state.profiles,
                        state.selectedInstanceId,
                    ),
                    options = state.profiles.map { profile ->
                        SelectorOption(
                            label = profile.displayName,
                            selected = profile.id == state.selectedInstanceId,
                        ) { onInstance(profile.id) }
                    },
                    enabled = selectorsEnabled && !state.loadingInstances,
                )
            }

            CompactSelector(
                label = "Model",
                value = NewSessionSelectorPolicy.modelLabel(state.modelOptions, state.selectedModelId),
                options = listOf(
                    SelectorOption("Backend default", state.selectedModelId == null) { onModel(null) },
                ) +
                    state.modelOptions.map { model ->
                        SelectorOption(model.label, model.id == state.selectedModelId) {
                            onModel(model.id)
                        }
                    },
                enabled = selectorsEnabled,
            )

            CompactSelector(
                label = "Permissions",
                value = NewSessionSelectorPolicy.runtimeLabel(state.runtimeMode),
                options = RuntimeMode.entries.map { mode ->
                    SelectorOption(
                        NewSessionSelectorPolicy.runtimeLabel(mode),
                        mode == state.runtimeMode,
                    ) {
                        onRuntimeMode(mode)
                    }
                },
                enabled = selectorsEnabled,
            )

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

private data class SelectorOption(
    val label: String,
    val selected: Boolean,
    val select: () -> Unit,
)

@Composable
private fun CompactSelector(
    label: String,
    value: String,
    options: List<SelectorOption>,
    enabled: Boolean,
) {
    var expanded by remember { mutableStateOf(false) }
    SectionLabel(label)
    Box(modifier = Modifier.fillMaxWidth()) {
        OutlinedButton(
            onClick = { expanded = true },
            enabled = enabled && options.isNotEmpty(),
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 52.dp)
                .semantics {
                    contentDescription = label
                    stateDescription = value
                },
        ) {
            Text(
                text = value,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Text("⌄", color = TextDim, modifier = Modifier.padding(start = 12.dp))
        }
        DropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false },
        ) {
            options.forEach { option ->
                DropdownMenuItem(
                    text = { Text(option.label) },
                    onClick = {
                        expanded = false
                        option.select()
                    },
                    trailingIcon = {
                        if (option.selected) Text("✓")
                    },
                    modifier = Modifier
                        .heightIn(min = 48.dp)
                        .semantics { selected = option.selected },
                )
            }
        }
    }
}

object NewSessionAccessibilityPolicy {
    fun choiceState(selected: Boolean): String = if (selected) "Selected" else "Not selected"

    fun launchState(submitting: Boolean): String = if (submitting) "Starting session" else "Start session"
}

object NewSessionSelectorPolicy {
    fun providerLabel(provider: ProviderKind): String = when (provider) {
        ProviderKind.Claude -> "Claude"
        ProviderKind.Codex -> "Codex"
        ProviderKind.OpenCode -> "OpenCode"
    }

    fun runtimeLabel(mode: RuntimeMode): String = when (mode) {
        RuntimeMode.Plan -> "Plan"
        RuntimeMode.Sandbox -> "Sandbox"
        RuntimeMode.AcceptEdits -> "Accept edits"
        RuntimeMode.FullAccess -> "Full access"
    }

    fun profileLabel(
        loading: Boolean,
        profiles: List<ProviderInstance>,
        selectedId: String?,
    ): String = when {
        loading -> "Loading profiles…"
        selectedId == null -> "Default profile"
        else -> profiles.firstOrNull { it.id == selectedId }?.displayName ?: "Default profile"
    }

    fun modelLabel(options: List<NewSessionModelOption>, selectedId: String?): String =
        selectedId?.let { id -> options.firstOrNull { it.id == id }?.label } ?: "Backend default"
}
