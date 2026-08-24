package app.switchboard.mobile.ui.newsession

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.KeyboardArrowRight
import app.switchboard.mobile.data.remote.NewSessionState
import app.switchboard.mobile.data.remote.NewSessionWorkspace
import app.switchboard.mobile.domain.remote.NewSessionDecisions
import app.switchboard.mobile.domain.remote.NewSessionModelOption
import app.switchboard.mobile.domain.remote.ProviderInstance
import app.switchboard.mobile.domain.remote.ProviderKind
import app.switchboard.mobile.domain.remote.RuntimeMode
import app.switchboard.mobile.ui.theme.Red
import app.switchboard.mobile.ui.theme.Surface
import app.switchboard.mobile.ui.theme.TextDim
import app.switchboard.mobile.ui.components.SectionLabel
import app.switchboard.mobile.ui.voice.NewSessionVoiceControl
import app.switchboard.mobile.ui.voice.VoiceNoticeRow
import app.switchboard.mobile.ui.voice.rememberVoiceComposer

@Composable
@OptIn(ExperimentalMaterial3Api::class)
fun NewSessionScreen(
    state: NewSessionState,
    onBack: () -> Unit,
    onProvider: (ProviderKind) -> Unit,
    onRuntimeMode: (RuntimeMode) -> Unit,
    onInstance: (String?) -> Unit,
    onModel: (String?) -> Unit,
    onWorkspace: (NewSessionWorkspace) -> Unit,
    onFirstMessage: (String) -> Unit,
    onStart: () -> Unit,
    onReconcileWorktree: () -> Unit,
    onRetryWorktree: () -> Unit,
    onRunWorktreeSetup: () -> Unit,
    onSkipWorktreeSetup: () -> Unit,
    onRetainWorktree: () -> Unit,
    onRemoveWorktree: () -> Unit,
    onStartInProject: () -> Unit,
    onCancelWorktree: () -> Unit,
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
        TopAppBar(
            title = {
                Column {
                    Text(
                        text = "New session",
                        maxLines = 1,
                        modifier = Modifier.semantics { heading() },
                    )
                    Text(
                        text = state.projectName,
                        color = TextDim,
                        style = MaterialTheme.typography.labelSmall,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            },
            navigationIcon = {
                IconButton(onClick = onBack, modifier = Modifier.size(48.dp)) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                }
            },
            colors = TopAppBarDefaults.topAppBarColors(containerColor = Surface),
        )
        HorizontalDivider()
        Column(
            modifier = Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp),
        ) {
            val selectorsEnabled = !state.submitting && !state.launchLocked
            val worktreePresentation = NewSessionWorktreePresentationPolicy.present(state)
            CompactSelector(
                field = NewSessionField.PROVIDER,
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
                    field = NewSessionField.PROFILE,
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
                field = NewSessionField.MODEL,
                value = NewSessionSelectorPolicy.modelLabel(state.modelOptions, state.selectedModelId),
                options = listOfNotNull(
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
                field = NewSessionField.RUNTIME,
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

            CompactSelector(
                field = NewSessionField.WORKSPACE,
                value = NewSessionWorktreePresentationPolicy.workspaceLabel(state.workspace),
                options = listOfNotNull(
                    SelectorOption(
                        label = "Parent checkout",
                        selected = state.workspace == NewSessionWorkspace.ParentCheckout,
                    ) {
                        onWorkspace(NewSessionWorkspace.ParentCheckout)
                    },
                    if (NewSessionWorktreePresentationPolicy.offersWorktreeChoice(state)) SelectorOption(
                        label = "New worktree",
                        selected = state.workspace is NewSessionWorkspace.Worktree,
                    ) {
                        onWorkspace(NewSessionWorktreePresentationPolicy.newWorktree())
                    } else null,
                ),
                enabled = selectorsEnabled,
            )

            worktreePresentation?.let { presentation ->
                WorktreeCreationStatusCard(
                    presentation = presentation,
                    onReconcile = onReconcileWorktree,
                    onRetry = onRetryWorktree,
                    onRunSetup = onRunWorktreeSetup,
                    onSkipSetup = onSkipWorktreeSetup,
                    onRetain = onRetainWorktree,
                    onRemove = onRemoveWorktree,
                    onStartInProject = onStartInProject,
                    onCancel = onCancelWorktree,
                    modifier = Modifier.padding(top = 16.dp),
                )
            }

            SectionLabel(
                text = "First message",
                modifier = Modifier.padding(top = 24.dp, bottom = 10.dp, start = 4.dp),
            )
            TextField(
                value = state.firstMessage,
                onValueChange = { text ->
                    voice.userEdited(text)
                    onFirstMessage(text)
                },
                minLines = 5,
                enabled = !state.submitting && !state.launchLocked,
                placeholder = { Text("What should the agent work on?", color = TextDim) },
                shape = RoundedCornerShape(16.dp),
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = MaterialTheme.colorScheme.surfaceVariant,
                    unfocusedContainerColor = MaterialTheme.colorScheme.surfaceVariant,
                    focusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
                    unfocusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
                ),
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
                state.error?.takeIf { worktreePresentation == null }?.let { message ->
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
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 12.dp, bottom = 24.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = state.projectPath,
                    color = TextDim,
                    style = MaterialTheme.typography.labelSmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (worktreePresentation == null) {
                    Button(
                        onClick = onStart,
                        enabled = !state.submitting && !state.loadingDefaults,
                        modifier = Modifier
                            .widthIn(min = 96.dp)
                            .heightIn(min = 48.dp)
                            .semantics {
                                contentDescription = NewSessionAccessibilityPolicy.launchState(
                                    submitting = state.submitting,
                                    worktree = state.workspace is NewSessionWorkspace.Worktree,
                                )
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
                            Text(
                                if (state.workspace is NewSessionWorkspace.Worktree) {
                                    "Create worktree"
                                } else {
                                    "Start"
                                },
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun WorktreeCreationStatusCard(
    presentation: NewSessionWorktreePresentation,
    onReconcile: () -> Unit,
    onRetry: () -> Unit,
    onRunSetup: () -> Unit,
    onSkipSetup: () -> Unit,
    onRetain: () -> Unit,
    onRemove: () -> Unit,
    onStartInProject: () -> Unit,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(16.dp))
            .padding(16.dp)
            .semantics {
                liveRegion = LiveRegionMode.Polite
                stateDescription = presentation.title
            },
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (presentation.showProgress) {
                CircularProgressIndicator(
                    strokeWidth = 2.dp,
                    modifier = Modifier
                        .padding(end = 12.dp)
                        .size(18.dp)
                        .clearAndSetSemantics {},
                )
            }
            Text(
                text = presentation.title,
                style = MaterialTheme.typography.titleSmall,
            )
        }
        presentation.correlation?.let {
            Text(
                text = it,
                color = TextDim,
                style = MaterialTheme.typography.labelSmall,
                modifier = Modifier.padding(top = 6.dp),
            )
        }
        presentation.detail?.let {
            Text(
                text = it,
                color = Red,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier
                    .padding(top = 10.dp)
                    .semantics { error(it) },
            )
        }
        if (presentation.canRunSetup) {
            Button(
                onClick = onRunSetup,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 12.dp)
                    .heightIn(min = 48.dp),
            ) {
                Text("Run setup")
            }
        }
        if (presentation.canSkipSetup) {
            OutlinedButton(
                onClick = onSkipSetup,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 8.dp)
                    .heightIn(min = 48.dp),
            ) {
                Text("Skip setup")
            }
        }
        if (presentation.canRetry) {
            Button(
                onClick = onRetry,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 12.dp)
                    .heightIn(min = 48.dp),
            ) {
                Text("Retry worktree creation")
            }
        }
        if (presentation.canReconcile) {
            OutlinedButton(
                onClick = onReconcile,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 8.dp)
                    .heightIn(min = 48.dp),
            ) {
                Text("Check status")
            }
        }
        if (presentation.canStartInProject) {
            OutlinedButton(
                onClick = onStartInProject,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 8.dp)
                    .heightIn(min = 48.dp),
            ) {
                Text("Start in project")
            }
        }
        if (presentation.canRetain) {
            OutlinedButton(
                onClick = onRetain,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 8.dp)
                    .heightIn(min = 48.dp),
            ) {
                Text("Keep worktree")
            }
        }
        if (presentation.canRemove) {
            OutlinedButton(
                onClick = onRemove,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 8.dp)
                    .heightIn(min = 48.dp),
            ) {
                Text("Remove worktree")
            }
        }
        if (presentation.canCancel) {
            OutlinedButton(
                onClick = onCancel,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 8.dp)
                    .heightIn(min = 48.dp),
            ) {
                Text("Cancel worktree creation")
            }
        }
    }
}

private data class SelectorOption(
    val label: String,
    val selected: Boolean,
    val select: () -> Unit,
)

@Composable
private fun CompactSelector(
    field: NewSessionField,
    value: String,
    options: List<SelectorOption>,
    enabled: Boolean,
) {
    var expanded by remember { mutableStateOf(false) }
    val label = NewSessionSelectorPolicy.supportingLabel(field)
    Box(modifier = Modifier.fillMaxWidth()) {
        ListItem(
            overlineContent = { Text(label.uppercase()) },
            headlineContent = {
                Text(value, maxLines = 1, overflow = TextOverflow.Ellipsis)
            },
            trailingContent = {
                Icon(Icons.Default.KeyboardArrowRight, contentDescription = null, tint = TextDim)
            },
            colors = ListItemDefaults.colors(containerColor = Surface),
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 64.dp)
                .semantics {
                    contentDescription = label
                    stateDescription = value
                }
                .clickable(
                    enabled = enabled && options.isNotEmpty(),
                    onClick = { expanded = true },
                ),
        )
        HorizontalDivider(modifier = Modifier.align(Alignment.BottomCenter))
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

    fun launchState(submitting: Boolean, worktree: Boolean = false): String = when {
        worktree && submitting -> "Creating worktree"
        worktree -> "Create worktree"
        submitting -> "Starting session"
        else -> "Start session"
    }
}

enum class NewSessionField {
    PROVIDER,
    PROFILE,
    MODEL,
    RUNTIME,
    WORKSPACE,
}

object NewSessionSelectorPolicy {
    fun supportingLabel(field: NewSessionField): String = when (field) {
        NewSessionField.PROVIDER -> "Agent"
        NewSessionField.PROFILE -> "Profile"
        NewSessionField.MODEL -> "Model"
        NewSessionField.RUNTIME -> "Access"
        NewSessionField.WORKSPACE -> "Workspace"
    }

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
