package app.switchboard.mobile.ui.thread

import android.provider.OpenableColumns
import android.graphics.BitmapFactory
import android.util.Base64
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.produceState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import app.switchboard.mobile.domain.composer.ComposerAttachment
import app.switchboard.mobile.domain.composer.ComposerImageSource
import app.switchboard.mobile.domain.composer.OutboxPresentationPolicy
import app.switchboard.mobile.domain.composer.OutboxUiAction
import app.switchboard.mobile.domain.outbox.OutboxDeliveryState
import app.switchboard.mobile.domain.outbox.QueuedTurn
import app.switchboard.mobile.domain.remote.ApprovalDecision
import app.switchboard.mobile.domain.thread.FeedItem
import app.switchboard.mobile.domain.remote.RuntimeMode
import app.switchboard.mobile.domain.remote.ProviderSkill
import app.switchboard.mobile.data.thread.ThreadPendingActions
import app.switchboard.mobile.data.thread.ThreadModelState
import app.switchboard.mobile.ui.theme.Accent
import app.switchboard.mobile.ui.theme.Amber
import app.switchboard.mobile.ui.theme.GeistMono
import app.switchboard.mobile.ui.theme.Green
import app.switchboard.mobile.ui.theme.Red
import app.switchboard.mobile.ui.theme.Surface
import app.switchboard.mobile.ui.theme.SurfaceRaised
import app.switchboard.mobile.ui.theme.TextDim
import app.switchboard.mobile.ui.components.InlineStatus
import app.switchboard.mobile.ui.components.InlineStatusProgress
import app.switchboard.mobile.ui.components.SectionLabel
import app.switchboard.mobile.ui.components.StatusTone
import app.switchboard.mobile.ui.components.SwitchboardListRow
import app.switchboard.mobile.ui.components.SwitchboardScaffold
import app.switchboard.mobile.ui.components.SwitchboardTopBarAction
import app.switchboard.mobile.ui.theme.SwitchboardDimensions
import app.switchboard.mobile.ui.voice.ThreadVoicePrimaryControl
import app.switchboard.mobile.ui.voice.VoiceNoticeRow
import app.switchboard.mobile.ui.voice.rememberVoiceComposer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

@Composable
fun ThreadScreen(
    threadId: String,
    title: String,
    backendLabel: String,
    loadState: ThreadLoadState,
    onRetry: () -> Unit,
    onAction: (ThreadUiAction) -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    composer: ThreadComposerPresentation? = null,
    onDraftChange: (String) -> Unit = {},
    onSend: () -> Unit = {},
    onInterrupt: () -> Unit = {},
    onRuntimeModeChange: (RuntimeMode) -> Unit = {},
    models: ThreadModelState = ThreadModelState(),
    onModelChange: (String) -> Unit = {},
    onRefreshModels: () -> Unit = {},
    onClearLocalFeed: () -> Unit = {},
    skills: List<ProviderSkill> = emptyList(),
    pendingActions: ThreadPendingActions = ThreadPendingActions(),
    onImagesSelected: (List<ComposerImageSource>) -> Unit = {},
    onRemoveImage: (String) -> Unit = {},
    queuedTurns: List<QueuedTurn> = emptyList(),
    onOutboxAction: (String, OutboxUiAction) -> Unit = { _, _ -> },
) {
    BackHandler(onBack = onBack)
    var selections by rememberSaveable(threadId) { mutableStateOf(QuestionSelections.empty()) }
    var lightboxUrl by rememberSaveable(threadId) { mutableStateOf<String?>(null) }
    var settingsOpen by rememberSaveable(threadId) { mutableStateOf(false) }
    val presentation = ThreadPresenter.present(loadState)
    val metadata = presentation.metadataOrNull()
    val rows = (presentation as? ThreadPresentation.Content)?.rows.orEmpty()
    val pendingApproval = ThreadChromePolicy.pendingApproval(rows)

    if (settingsOpen && composer != null) {
        ThreadAgentSettingsScreen(
            settings = ThreadComposerPresentationPolicy.settingsAffordance(
                modelLabel = composer.modelLabel,
                runtimeMode = composer.runtimeMode,
            ),
            selectedMode = composer.runtimeMode,
            modeEnabled = !composer.modeChanging,
            models = models,
            onModeSelected = onRuntimeModeChange,
            onModelSelected = onModelChange,
            onRefreshModels = onRefreshModels,
            onBack = { settingsOpen = false },
            modifier = modifier,
        )
        return
    }

    SwitchboardScaffold(
        title = title,
        subtitle = metadata?.let(ThreadChromePolicy::subtitle) ?: backendLabel,
        modifier = modifier.fillMaxSize(),
        navigationIcon = {
            SwitchboardTopBarAction(contentDescription = "Back", onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = null)
            }
        },
        actions = {
            if (composer != null) {
                SwitchboardTopBarAction(
                    contentDescription = "Agent settings",
                    onClick = { settingsOpen = true },
                ) {
                    Icon(Icons.Filled.MoreVert, contentDescription = null)
                }
            }
        },
        bottomBar = {
            ThreadBottomArea(
                contentStatus = presentation.contentStatusOrNull(),
                pendingApproval = pendingApproval,
                pendingDecision = pendingApproval?.let {
                    pendingActions.approvalDecisions[it.source.requestId]
                },
                composer = composer,
                queuedTurns = queuedTurns,
                onRetry = onRetry,
                onAction = onAction,
                onOutboxAction = onOutboxAction,
                onDraftChange = onDraftChange,
                onSend = onSend,
                onInterrupt = onInterrupt,
                onOpenSettings = { settingsOpen = true },
                onRuntimeModeChange = onRuntimeModeChange,
                onClearLocalFeed = onClearLocalFeed,
                skills = skills,
                onImagesSelected = onImagesSelected,
                onRemoveImage = onRemoveImage,
            )
        },
    ) { scaffoldPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(scaffoldPadding),
        ) {
            metadata?.let { ThreadMetricStrip(it) }
            Box(modifier = Modifier.weight(1f)) {
            when (presentation) {
                ThreadPresentation.Loading -> FullPageLoading()
                is ThreadPresentation.Failure -> FullPageFailure(presentation.message, onRetry)
                is ThreadPresentation.Empty -> Column(Modifier.fillMaxSize()) {
                    EmptyThread()
                }

                is ThreadPresentation.Content -> key(threadId) {
                    LazyColumn(
                        modifier = Modifier
                            .fillMaxSize()
                            .testTag(ThreadTestTags.FEED),
                        reverseLayout = true,
                        contentPadding = PaddingValues(top = 24.dp),
                    ) {
                        items(
                            ThreadFeedLayoutPolicy.declarationOrder(
                                ThreadChromePolicy.feedRows(presentation.rows),
                            ),
                            key = { "feed:${it.key}" },
                        ) { row ->
                            ThreadRow(
                                row = row,
                                backendLabel = backendLabel,
                                selections = selections,
                                onSelectionsChange = { selections = it },
                                pendingActions = pendingActions,
                                onAction = onAction,
                                onImageOpen = { lightboxUrl = it },
                            )
                        }
                    }
                }
            }
        }
        }
    }
    lightboxUrl?.let { url ->
        ThreadImageLightbox(url = url, onDismiss = { lightboxUrl = null })
    }
}

private fun ThreadPresentation.metadataOrNull(): ThreadMetadataPresentation? = when (this) {
    is ThreadPresentation.Content -> metadata
    is ThreadPresentation.Empty -> metadata
    ThreadPresentation.Loading,
    is ThreadPresentation.Failure -> null
}

private fun ThreadPresentation.contentStatusOrNull(): ThreadContentStatus? = when (this) {
    is ThreadPresentation.Content -> contentStatus
    is ThreadPresentation.Empty -> contentStatus
    ThreadPresentation.Loading,
    is ThreadPresentation.Failure -> null
}

@Composable
private fun ThreadBottomArea(
    contentStatus: ThreadContentStatus?,
    pendingApproval: ThreadRowPresentation.Approval?,
    pendingDecision: ApprovalDecision?,
    composer: ThreadComposerPresentation?,
    queuedTurns: List<QueuedTurn>,
    onRetry: () -> Unit,
    onAction: (ThreadUiAction) -> Unit,
    onOutboxAction: (String, OutboxUiAction) -> Unit,
    onDraftChange: (String) -> Unit,
    onSend: () -> Unit,
    onInterrupt: () -> Unit,
    onOpenSettings: () -> Unit,
    onRuntimeModeChange: (RuntimeMode) -> Unit,
    onClearLocalFeed: () -> Unit,
    skills: List<ProviderSkill>,
    onImagesSelected: (List<ComposerImageSource>) -> Unit,
    onRemoveImage: (String) -> Unit,
) {
    Column(modifier = Modifier.fillMaxWidth()) {
        contentStatus?.takeIf { it.shouldRenderInline() }?.let {
            ContentStatus(it, onRetry)
        }
        if (queuedTurns.isNotEmpty()) {
            OutboxTray(queuedTurns, onOutboxAction)
        }
        if (pendingApproval != null) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(MaterialTheme.colorScheme.background)
                    .testTag(ThreadTestTags.APPROVAL_SLOT),
            ) {
                ApprovalRow(pendingApproval.source, pendingDecision, onAction)
            }
        }
        if (composer != null) {
            ThreadComposer(
                state = composer,
                onDraftChange = onDraftChange,
                onSend = onSend,
                onInterrupt = onInterrupt,
                onOpenSettings = onOpenSettings,
                onRuntimeModeChange = onRuntimeModeChange,
                onClearLocalFeed = onClearLocalFeed,
                skills = skills,
                onImagesSelected = onImagesSelected,
                onRemoveImage = onRemoveImage,
            )
        }
    }
}

private fun ThreadContentStatus.shouldRenderInline(): Boolean =
    kind != ThreadContentStatusKind.NORMAL || showProgress || canRetry || detail != null

@Composable
private fun ThreadComposer(
    state: ThreadComposerPresentation,
    onDraftChange: (String) -> Unit,
    onSend: () -> Unit,
    onInterrupt: () -> Unit,
    onOpenSettings: () -> Unit,
    onRuntimeModeChange: (RuntimeMode) -> Unit,
    onClearLocalFeed: () -> Unit,
    skills: List<ProviderSkill>,
    onImagesSelected: (List<ComposerImageSource>) -> Unit,
    onRemoveImage: (String) -> Unit,
) {
    val context = LocalContext.current
    val voice = rememberVoiceComposer(
        draft = state.draft,
        onDraft = onDraftChange,
    )
    val imagePicker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments(),
    ) { uris ->
        val remaining = (4 - state.attachments.size).coerceAtLeast(0)
        onImagesSelected(
            uris.take(remaining).map { uri ->
                val displayName = runCatching {
                    context.contentResolver.query(
                        uri,
                        arrayOf(OpenableColumns.DISPLAY_NAME),
                        null,
                        null,
                        null,
                    )?.use { cursor ->
                        if (cursor.moveToFirst()) cursor.getString(0) else null
                    }
                }.getOrNull() ?: uri.lastPathSegment ?: "image"
                ComposerImageSource(
                    contentUri = uri.toString(),
                    mimeType = context.contentResolver.getType(uri),
                    displayName = displayName,
                )
            },
        )
    }
    val focusRequester = remember { FocusRequester() }
    var focused by remember { mutableStateOf(false) }
    val slashQuery = ThreadSlashPolicy.query(state.draft)
    val slashCommands = remember(skills, slashQuery) {
        slashQuery?.let { ThreadSlashPolicy.filter(ThreadSlashPolicy.commands(skills), it) }.orEmpty()
    }
    fun runSlash(command: ThreadSlashCommand) {
        val action = command.action
        onDraftChange(if (action is ThreadSlashAction.Insert) action.text else "")
        when (action) {
            is ThreadSlashAction.SetMode -> onRuntimeModeChange(action.mode)
            ThreadSlashAction.ClearLocalFeed -> onClearLocalFeed()
            ThreadSlashAction.Interrupt -> onInterrupt()
            ThreadSlashAction.AttachImage -> imagePicker.launch(arrayOf("image/*"))
            is ThreadSlashAction.Insert -> focusRequester.requestFocus()
        }
    }
    LaunchedEffect(state.focusRequest) {
        if (state.focusRequest > 0) focusRequester.requestFocus()
    }
    val density = ThreadComposerPresentationPolicy.density(
        focused = focused,
        hasAttachments = state.attachments.isNotEmpty(),
        hasTransientContent = state.error != null ||
            state.controlMessage != null ||
            (slashQuery != null && slashCommands.isNotEmpty()),
    )
    val settings = ThreadComposerPresentationPolicy.settingsAffordance(
        modelLabel = state.modelLabel,
        runtimeMode = state.runtimeMode,
    )
    val showsSecondaryActions = ThreadComposerPresentationPolicy.showsSecondaryActions(density)
    val inputLayout = ThreadComposerPresentationPolicy.inputLayout(density)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(Surface)
            .padding(
                horizontal = 12.dp,
                vertical = if (density == ThreadComposerDensity.Compact) 6.dp else 10.dp,
            ),
        verticalArrangement = Arrangement.spacedBy(
            if (density == ThreadComposerDensity.Compact) 4.dp else 8.dp,
        ),
    ) {
        state.error?.let {
            Text(it, color = Red, style = MaterialTheme.typography.labelSmall)
        }
        state.controlMessage?.let {
            Text(it, color = Amber, style = MaterialTheme.typography.labelSmall)
        }
        if (slashQuery != null && slashCommands.isNotEmpty()) {
            ThreadSlashMenu(slashCommands, ::runSlash)
        }
        if (state.attachments.isNotEmpty()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                state.attachments.forEach { attachment ->
                    ComposerAttachmentPreview(
                        attachment = attachment,
                        onRemove = { onRemoveImage(attachment.id) },
                    )
                }
            }
        }
        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = MaterialTheme.shapes.large,
            color = MaterialTheme.colorScheme.surface,
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
            tonalElevation = 0.dp,
        ) {
            Row(
                modifier = Modifier.padding(horizontal = 4.dp, vertical = 3.dp),
                verticalAlignment = Alignment.Bottom,
            ) {
                IconButton(
                    onClick = { imagePicker.launch(arrayOf("image/*")) },
                    enabled = state.attachments.size < 4 && !state.submitting,
                    modifier = Modifier.size(SwitchboardDimensions.minimumTouchTarget),
                ) {
                    Icon(Icons.Filled.Add, contentDescription = "Attach image")
                }
                TextField(
                    value = state.draft,
                    onValueChange = { text ->
                        voice.userEdited(text)
                        onDraftChange(text)
                    },
                    modifier = Modifier
                        .weight(1f)
                        .testTag(ThreadTestTags.COMPOSER_INPUT)
                        .focusRequester(focusRequester)
                        .onFocusChanged { focused = it.isFocused }
                        .heightIn(min = SwitchboardDimensions.minimumTouchTarget),
                    placeholder = {
                        Text(if (state.showInterrupt) "Queue a follow-up…" else "Message the agent…")
                    },
                    singleLine = inputLayout.singleLine,
                    minLines = 1,
                    maxLines = inputLayout.maxLines,
                    colors = TextFieldDefaults.colors(
                        focusedContainerColor = Color.Transparent,
                        unfocusedContainerColor = Color.Transparent,
                        disabledContainerColor = Color.Transparent,
                        focusedIndicatorColor = Color.Transparent,
                        unfocusedIndicatorColor = Color.Transparent,
                        disabledIndicatorColor = Color.Transparent,
                    ),
                )
                ThreadVoicePrimaryControl(
                    voice = voice,
                    canSend = state.canSend,
                    agentRunning = state.showInterrupt,
                    enabled = !state.submitting && !state.interrupting,
                    onSend = onSend,
                    onStopAgent = onInterrupt,
                    modifier = Modifier.padding(bottom = 1.dp),
                )
            }
        }
        if (showsSecondaryActions) {
            VoiceNoticeRow(voice = voice)
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(
                    onClick = onOpenSettings,
                    enabled = !state.modeChanging,
                    modifier = Modifier
                        .heightIn(min = SwitchboardDimensions.minimumTouchTarget)
                        .testTag(ThreadTestTags.AGENT_SETTINGS_ACTION),
                ) {
                    Text(
                        "${settings.label} · ${settings.supportingLabel}",
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

@Composable
private fun ThreadAgentSettingsScreen(
    settings: ThreadSettingsAffordance,
    selectedMode: RuntimeMode,
    modeEnabled: Boolean,
    models: ThreadModelState,
    onModeSelected: (RuntimeMode) -> Unit,
    onModelSelected: (String) -> Unit,
    onRefreshModels: () -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    BackHandler(onBack = onBack)
    SwitchboardScaffold(
        title = "Agent settings",
        subtitle = "Applied to this thread",
        modifier = modifier
            .fillMaxSize()
            .testTag(ThreadTestTags.AGENT_SETTINGS_SCREEN),
        navigationIcon = {
            SwitchboardTopBarAction(
                contentDescription = "Back to thread",
                onClick = onBack,
                modifier = Modifier.testTag(ThreadTestTags.AGENT_SETTINGS_BACK),
            ) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = null)
            }
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState()),
        ) {
            if (models.loading) {
                InlineStatus(
                    message = "Loading models",
                    tone = StatusTone.INFO,
                    progress = InlineStatusProgress.Indeterminate,
                    modifier = Modifier.padding(
                        horizontal = SwitchboardDimensions.screenHorizontalPadding,
                        vertical = 12.dp,
                    ),
                )
            } else if (models.options.isNotEmpty()) {
                SectionLabel(
                    text = "Model",
                    modifier = Modifier.padding(
                        start = SwitchboardDimensions.screenHorizontalPadding,
                        end = SwitchboardDimensions.screenHorizontalPadding,
                        top = 20.dp,
                        bottom = 8.dp,
                    ),
                )
                models.options.forEachIndexed { index, model ->
                    SwitchboardListRow(
                        title = model.label.ifBlank { model.id },
                        supportingText = model.tier.takeIf(String::isNotBlank),
                        onClick = if (!models.changing) ({ onModelSelected(model.id) }) else null,
                        showDivider = index != models.options.lastIndex,
                        trailingContent = {
                            RadioButton(
                                selected = model.id == models.selectedModelId,
                                onClick = null,
                                enabled = !models.changing,
                            )
                        },
                    )
                }
            }
            models.error?.let { error ->
                InlineStatus(
                    message = "Could not update model",
                    detail = error,
                    tone = StatusTone.ERROR,
                    actionLabel = "Retry",
                    onAction = onRefreshModels,
                    modifier = Modifier.padding(
                        horizontal = SwitchboardDimensions.screenHorizontalPadding,
                        vertical = 12.dp,
                    ),
                )
            }
            SectionLabel(
                text = "Permission mode",
                modifier = Modifier.padding(
                    start = SwitchboardDimensions.screenHorizontalPadding,
                    end = SwitchboardDimensions.screenHorizontalPadding,
                    top = 24.dp,
                    bottom = 8.dp,
                ),
            )
            RuntimeMode.entries.forEachIndexed { index, mode ->
                SwitchboardListRow(
                    title = mode.presentationLabel(),
                    supportingText = mode.supportingDescription(),
                    onClick = if (modeEnabled) ({ onModeSelected(mode) }) else null,
                    showDivider = index != RuntimeMode.entries.lastIndex,
                    trailingContent = {
                        RadioButton(
                            selected = mode == selectedMode,
                            onClick = null,
                            enabled = modeEnabled,
                        )
                    },
                )
            }
            Text(
                text = "Permission changes affect future tool calls. They do not rewrite earlier messages.",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(
                    horizontal = SwitchboardDimensions.screenHorizontalPadding,
                    vertical = 20.dp,
                ),
            )
        }
    }
}

private fun RuntimeMode.supportingDescription(): String = when (this) {
    RuntimeMode.Plan -> "Read-only planning and questions"
    RuntimeMode.Sandbox -> "Run commands in the workspace sandbox"
    RuntimeMode.AcceptEdits -> "Allow file edits while protecting broader access"
    RuntimeMode.FullAccess -> "Allow commands and file access without prompts"
}

@Composable
private fun ThreadSlashMenu(
    commands: List<ThreadSlashCommand>,
    onPick: (ThreadSlashCommand) -> Unit,
) {
    Card(
        colors = CardDefaults.cardColors(containerColor = SurfaceRaised),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(max = 260.dp)
                .verticalScroll(rememberScrollState())
                .padding(vertical = 6.dp),
        ) {
            var previousSource: ThreadSlashSource? = null
            commands.forEach { command ->
                if (command.source != previousSource) {
                    Text(
                        text = command.source.menuLabel(),
                        color = TextDim,
                        fontFamily = GeistMono,
                        fontSize = 10.sp,
                        modifier = Modifier.padding(start = 12.dp, top = 8.dp, bottom = 3.dp),
                    )
                    previousSource = command.source
                }
                PressableLine(enabled = true, onClick = { onPick(command) }) {
                    Text(
                        text = "/${command.name}",
                        color = Accent,
                        fontFamily = GeistMono,
                        fontWeight = FontWeight.SemiBold,
                    )
                    command.argumentHint?.takeIf(String::isNotBlank)?.let {
                        Text(" $it", color = TextDim, fontFamily = GeistMono)
                    }
                    Spacer(Modifier.weight(1f))
                    Text(
                        text = command.description,
                        color = TextDim,
                        style = MaterialTheme.typography.labelSmall,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(start = 10.dp),
                    )
                }
            }
        }
    }
}

private fun ThreadSlashSource.menuLabel(): String = when (this) {
    ThreadSlashSource.Switchboard -> "SWITCHBOARD"
    is ThreadSlashSource.Agent -> value.uppercase()
}

@Composable
private fun ComposerAttachmentPreview(
    attachment: ComposerAttachment,
    onRemove: () -> Unit,
) {
    val bitmap by produceState<androidx.compose.ui.graphics.ImageBitmap?>(
        initialValue = null,
        key1 = attachment.privateUri,
    ) {
        value = withContext(Dispatchers.IO) {
            decodeThumbnail(attachment.privateUri)?.asImageBitmap()
        }
    }
    Box(
        modifier = Modifier
            .size(64.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(SurfaceRaised),
    ) {
        bitmap?.let {
            Image(
                bitmap = it,
                contentDescription = attachment.displayName,
                modifier = Modifier.fillMaxSize(),
            )
        } ?: Text(
            text = attachment.displayName,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            style = MaterialTheme.typography.labelSmall,
            modifier = Modifier.padding(6.dp),
        )
        IconButton(
            onClick = onRemove,
            modifier = Modifier
                .align(Alignment.TopEnd)
                .size(SwitchboardDimensions.minimumTouchTarget),
        ) {
            Icon(
                imageVector = Icons.Filled.Close,
                contentDescription = "Remove ${attachment.displayName}",
            )
        }
    }
}

private fun decodeThumbnail(path: String, maxDimension: Int = 256): android.graphics.Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(path, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sampleSize = 1
    while (bounds.outWidth / sampleSize > maxDimension * 2 ||
        bounds.outHeight / sampleSize > maxDimension * 2
    ) {
        sampleSize *= 2
    }
    return BitmapFactory.decodeFile(
        path,
        BitmapFactory.Options().apply { inSampleSize = sampleSize },
    )
}

@Composable
private fun OutboxTray(
    turns: List<QueuedTurn>,
    onAction: (String, OutboxUiAction) -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(SurfaceRaised)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        turns.forEach { turn ->
            val (label, reason) = when (val state = turn.deliveryState) {
                OutboxDeliveryState.Pending -> "Queued" to null
                is OutboxDeliveryState.Ambiguous -> "Delivery uncertain" to state.reason
                is OutboxDeliveryState.Terminal -> "Not delivered" to state.reason
                is OutboxDeliveryState.Acknowledged -> "Delivered" to null
            }
            Card(colors = CardDefaults.cardColors(containerColor = Surface)) {
                Column(Modifier.padding(10.dp)) {
                    Text(label, style = MaterialTheme.typography.labelMedium)
                    if (turn.text.isNotBlank()) {
                        Text(turn.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                    reason?.let { Text(it, color = Red, style = MaterialTheme.typography.labelSmall) }
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        OutboxPresentationPolicy.actions(turn).forEach { action ->
                            TextButton(onClick = { onAction(turn.origin, action) }) {
                                Text(action.name)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ThreadMetricStrip(metadata: ThreadMetadataPresentation) {
    val values = ThreadChromePolicy.metadataSummary(metadata)
    if (values.isEmpty()) return
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .semantics(mergeDescendants = true) {
                contentDescription = values.joinToString(", ")
            }
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 7.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        values.forEach { value ->
            Text(
                text = value,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.labelSmall,
                maxLines = 1,
            )
        }
    }
}

@Composable
private fun ContentStatus(status: ThreadContentStatus, onRetry: () -> Unit) {
    InlineStatus(
        message = status.label,
        detail = status.detail,
        tone = when (status.kind) {
            ThreadContentStatusKind.NORMAL -> StatusTone.NEUTRAL
            ThreadContentStatusKind.CACHED -> StatusTone.INFO
            ThreadContentStatusKind.ERROR -> StatusTone.ERROR
        },
        progress = if (status.showProgress) {
            InlineStatusProgress.Indeterminate
        } else {
            InlineStatusProgress.None
        },
        actionLabel = if (status.canRetry) "Retry" else null,
        onAction = if (status.canRetry) onRetry else null,
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.background)
            .padding(horizontal = 12.dp, vertical = 6.dp),
    )
}

@Composable
private fun ThreadRow(
    row: ThreadRowPresentation,
    backendLabel: String,
    selections: QuestionSelections,
    onSelectionsChange: (QuestionSelections) -> Unit,
    pendingActions: ThreadPendingActions,
    onAction: (ThreadUiAction) -> Unit,
    onImageOpen: (String) -> Unit,
) {
    when (row) {
        is ThreadRowPresentation.User -> UserRow(row.source, onImageOpen)
        is ThreadRowPresentation.Text -> TextRow(row)
        is ThreadRowPresentation.Tool -> ToolRow(row)
        is ThreadRowPresentation.Denial -> NoticeCard(
            title = "Blocked · ${row.source.toolName}",
            body = "${row.source.reason} (${row.source.mode})",
            tint = Red,
        )

        is ThreadRowPresentation.Approval -> ApprovalRow(
            row.source,
            pendingActions.approvalDecisions[row.source.requestId],
            onAction,
        )
        is ThreadRowPresentation.Retry -> NoticeCard(
            title = if (row.source.active) "Retrying" else "Retry finished",
            body = row.source.message,
            tint = Amber,
            progress = row.source.active,
        )

        is ThreadRowPresentation.Error -> NoticeCard("Error", row.source.message, Red)
        is ThreadRowPresentation.Plan -> PlanRow(
            row.source,
            row.source.planId in pendingActions.planIds,
            onAction,
        )
        is ThreadRowPresentation.Question -> QuestionRow(
            item = row.source,
            selections = selections,
            onSelectionsChange = onSelectionsChange,
            submitting = row.source.requestId in pendingActions.questionRequestIds,
            onAction = onAction,
        )

        is ThreadRowPresentation.FileEdit -> FileEditRow(row, backendLabel)
        is ThreadRowPresentation.Drift -> NoticeCard(
            "Worktree changed",
            "${row.source.branch}\n${row.source.worktreePath}",
            Amber,
        )

        is ThreadRowPresentation.SpendBlocked -> SpendRow(row.source)
        is ThreadRowPresentation.Peer -> PeerRow(row.source)
        is ThreadRowPresentation.Todo -> TodoRow(row.source)
        is ThreadRowPresentation.Notice -> NoticeCard(
            title = row.title,
            body = row.body,
            tint = TextDim,
        )
        is ThreadRowPresentation.RawNotice -> NoticeCard(
            title = "Unsupported event · ${row.eventType}",
            body = "${row.source.text}\n${row.raw}",
            tint = TextDim,
        )
    }
}

@Composable
private fun UserRow(item: FeedItem.User, onImageOpen: (String) -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 7.dp),
        horizontalArrangement = Arrangement.End,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth(0.86f)
                .clip(MaterialTheme.shapes.medium)
                .background(MaterialTheme.colorScheme.primary)
                .padding(horizontal = 14.dp, vertical = 11.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (item.text.isNotBlank()) {
                Text(
                    text = item.text,
                    color = MaterialTheme.colorScheme.onPrimary,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            if (item.images.isNotEmpty()) {
                Row(
                    modifier = Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    item.images.forEach { image ->
                        ThreadHistoryImage(
                            url = image.url,
                            name = image.name,
                            onOpen = { onImageOpen(image.url) },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ThreadHistoryImage(
    url: String,
    name: String?,
    onOpen: () -> Unit,
) {
    val bitmap by rememberThreadImage(url, maxDimension = 512)
    Box(
        modifier = Modifier
            .size(180.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(Surface)
            .clickable(enabled = bitmap != null, onClick = onOpen),
        contentAlignment = Alignment.Center,
    ) {
        bitmap?.let {
            Image(
                bitmap = it,
                contentDescription = name ?: "Attached image",
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        } ?: Text(
            text = "Image unavailable",
            color = TextDim,
            style = MaterialTheme.typography.labelSmall,
            modifier = Modifier.padding(12.dp),
        )
    }
}

@Composable
private fun ThreadImageLightbox(url: String, onDismiss: () -> Unit) {
    val bitmap by rememberThreadImage(url, maxDimension = 2048)
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(androidx.compose.ui.graphics.Color.Black)
                .clickable(onClick = onDismiss),
            contentAlignment = Alignment.Center,
        ) {
            bitmap?.let {
                Image(
                    bitmap = it,
                    contentDescription = "Attached image preview",
                    contentScale = ContentScale.Fit,
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(18.dp),
                )
            } ?: CircularProgressIndicator()
            TextButton(
                onClick = onDismiss,
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .statusBarsPadding()
                    .padding(8.dp),
            ) { Text("Close") }
        }
    }
}

@Composable
private fun rememberThreadImage(
    url: String,
    maxDimension: Int,
) = produceState<androidx.compose.ui.graphics.ImageBitmap?>(
    initialValue = null,
    key1 = url,
    key2 = maxDimension,
) {
    value = withContext(Dispatchers.IO) {
        decodeThreadImage(url, maxDimension)?.asImageBitmap()
    }
}

private fun decodeThreadImage(url: String, maxDimension: Int): android.graphics.Bitmap? {
    ThreadImageFile.parse(url)?.let { source ->
        val file = File(source.path)
        val size = runCatching { file.length() }.getOrNull() ?: return null
        if (!file.isFile || size !in 1..ThreadImageData.MaxDecodedBytes.toLong()) return null
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        return BitmapFactory.decodeFile(
            file.path,
            BitmapFactory.Options().apply {
                inSampleSize = imageSampleSize(bounds.outWidth, bounds.outHeight, maxDimension)
            },
        )
    }
    val image = ThreadImageData.parse(url) ?: return null
    val bytes = runCatching { Base64.decode(image.base64, Base64.DEFAULT) }.getOrNull() ?: return null
    if (bytes.size != image.decodedBytes) return null
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    return BitmapFactory.decodeByteArray(
        bytes,
        0,
        bytes.size,
        BitmapFactory.Options().apply {
            inSampleSize = imageSampleSize(bounds.outWidth, bounds.outHeight, maxDimension)
        },
    )
}

private fun imageSampleSize(width: Int, height: Int, maxDimension: Int): Int {
    var sampleSize = 1
    while (width / sampleSize > maxDimension * 2 || height / sampleSize > maxDimension * 2) {
        sampleSize *= 2
    }
    return sampleSize
}

@Composable
private fun TextRow(row: ThreadRowPresentation.Text) {
    var expanded by rememberSaveable(row.key) { mutableStateOf(false) }
    val reasoning = row.kind == ThreadRowKind.REASONING
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        Text(
            text = when (row.kind) {
                ThreadRowKind.REASONING -> "REASONING"
                ThreadRowKind.PLAN_STREAM -> "PLAN"
                else -> "AGENT"
            },
            color = if (row.kind == ThreadRowKind.PLAN_STREAM) Accent else TextDim,
            style = MaterialTheme.typography.labelSmall,
        )
        if (reasoning) {
            Text(
                text = row.source.text,
                style = MaterialTheme.typography.bodyMedium,
                fontStyle = FontStyle.Italic,
                maxLines = if (!expanded) 4 else Int.MAX_VALUE,
                overflow = TextOverflow.Ellipsis,
            )
        } else {
            ThreadRichText(row.source.text)
        }
        if (reasoning) {
            TextButton(
                onClick = { expanded = !expanded },
                modifier = Modifier.heightIn(min = 48.dp),
            ) {
                Text(if (expanded) "Show less" else "Show more")
            }
        }
        row.durationLabel?.let {
            Text("Worked for $it", color = TextDim, style = MaterialTheme.typography.labelSmall)
        }
    }
}

@Composable
private fun ToolRow(row: ThreadRowPresentation.Tool) {
    val hasDetails = row.input.isNotBlank() || !row.output.isNullOrBlank()
    var expanded by rememberSaveable(row.key) { mutableStateOf(false) }
    CardContainer(tint = TextDim) {
        PressableLine(
            enabled = hasDetails,
            onClick = { expanded = !expanded },
        ) {
            if (row.source.state == "running") {
                CircularProgressIndicator(modifier = Modifier.size(15.dp), strokeWidth = 2.dp)
            }
            Text(
                text = row.source.toolName,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.padding(start = if (row.source.state == "running") 9.dp else 0.dp),
            )
            Spacer(Modifier.weight(1f))
            Text(row.source.state, color = TextDim, style = MaterialTheme.typography.labelSmall)
        }
        if (expanded && hasDetails) {
            if (row.input.isNotBlank()) MonoBlock("Input", row.input)
            row.output?.takeIf(String::isNotBlank)?.let { MonoBlock("Output", it) }
        }
    }
}

@Composable
private fun ApprovalRow(
    item: FeedItem.Approval,
    pendingDecision: ApprovalDecision?,
    onAction: (ThreadUiAction) -> Unit,
) {
    val pending = item.state == "pending"
    CardContainer(tint = if (pending) Amber else TextDim) {
        Text(
            if (pending) "Approval needed" else item.state.replaceFirstChar(Char::uppercaseChar),
            fontWeight = FontWeight.SemiBold,
        )
        Text(item.toolName, color = Accent, fontFamily = GeistMono)
        Text(item.detail, style = MaterialTheme.typography.bodyMedium)
        if (pending) {
            if (pendingDecision != null) {
                Row(
                    modifier = Modifier.heightIn(min = 48.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(9.dp),
                ) {
                    CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                    Text(
                        if (pendingDecision == ApprovalDecision.Approve) "Approving…" else "Denying…",
                        color = TextDim,
                    )
                }
            } else Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = {
                        ThreadInteractionPolicy.approval(item, ThreadApprovalDecision.APPROVE)
                            ?.let(onAction)
                    },
                    modifier = Modifier
                        .weight(1f)
                        .heightIn(min = 48.dp),
                ) { Text("Approve") }
                OutlinedButton(
                    onClick = {
                        ThreadInteractionPolicy.approval(item, ThreadApprovalDecision.DENY)
                            ?.let(onAction)
                    },
                    modifier = Modifier
                        .weight(1f)
                        .heightIn(min = 48.dp),
                ) { Text("Deny") }
            }
        }
    }
}

@Composable
private fun QuestionRow(
    item: FeedItem.Question,
    selections: QuestionSelections,
    onSelectionsChange: (QuestionSelections) -> Unit,
    submitting: Boolean,
    onAction: (ThreadUiAction) -> Unit,
) {
    val answered = item.answers != null
    CardContainer(tint = Accent) {
        Text(if (answered) "Answered" else "Question", fontWeight = FontWeight.SemiBold)
        item.questions.forEachIndexed { questionIndex, question ->
            if (question.header.isNotBlank()) {
                Text(question.header, color = TextDim, style = MaterialTheme.typography.labelSmall)
            }
            Text(question.question, style = MaterialTheme.typography.bodyMedium)
            if (question.multiSelect && !answered) {
                Text("Select one or more.", color = TextDim, style = MaterialTheme.typography.labelSmall)
            }
            val shown = item.answers ?: selections.forRequest(item.requestId)
            question.options.forEachIndexed { optionIndex, option ->
                val selected = option.label in shown.getOrNull(questionIndex).orEmpty()
                TextButton(
                    onClick = {
                        onSelectionsChange(
                            QuestionSelectionReducer.toggle(
                                selections,
                                item,
                                questionIndex,
                                option.label,
                            ),
                        )
                    },
                    enabled = !answered && !submitting,
                    colors = ButtonDefaults.textButtonColors(
                        contentColor = if (selected) Accent else MaterialTheme.colorScheme.onSurface,
                    ),
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 48.dp),
                ) {
                    Text("${optionIndex + 1}. ${option.label}", modifier = Modifier.weight(1f))
                    option.description?.takeIf { it != option.label }?.let {
                        Text(it, color = TextDim, style = MaterialTheme.typography.labelSmall)
                    }
                    if (selected) Text("  [x]", fontFamily = GeistMono)
                }
            }
        }
        if (!answered) {
            Button(
                onClick = {
                    ThreadInteractionPolicy.answer(item, selections)?.let(onAction)
                },
                enabled = !submitting && QuestionSelectionReducer.canSubmit(selections, item),
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp),
            ) { Text(if (submitting) "Submitting…" else "Submit answers") }
        }
    }
}

@Composable
private fun PlanRow(
    item: FeedItem.Plan,
    pending: Boolean,
    onAction: (ThreadUiAction) -> Unit,
) {
    CardContainer(tint = Accent) {
        Text("Proposed Plan", fontWeight = FontWeight.SemiBold)
        ThreadRichText(item.markdown)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = { onAction(ThreadInteractionPolicy.plan(item, ThreadPlanAction.IMPLEMENT)) },
                enabled = !pending,
                modifier = Modifier
                    .weight(1f)
                    .heightIn(min = 48.dp),
            ) { Text(if (pending) "Starting…" else "Implement") }
            OutlinedButton(
                onClick = { onAction(ThreadInteractionPolicy.plan(item, ThreadPlanAction.ITERATE)) },
                enabled = !pending,
                modifier = Modifier
                    .weight(1f)
                    .heightIn(min = 48.dp),
            ) { Text("Iterate") }
        }
    }
}

@Composable
private fun FileEditRow(
    row: ThreadRowPresentation.FileEdit,
    backendLabel: String,
) {
    CardContainer(tint = Green) {
        Text("${row.source.changeKind} ${row.relPath}", fontWeight = FontWeight.SemiBold)
        Row {
            Text("+${row.addedLines}", color = Green, fontFamily = GeistMono)
            Text("-${row.removedLines}", color = Red, fontFamily = GeistMono, modifier = Modifier.padding(start = 10.dp))
            Text("Changed on $backendLabel", color = TextDim, modifier = Modifier.padding(start = 10.dp))
        }
    }
}

@Composable
private fun SpendRow(item: FeedItem.SpendBlocked) {
    val target = listOfNotNull(item.instanceId, item.model).joinToString(" · ")
    val detail = listOfNotNull(
        target.takeIf(String::isNotBlank),
        item.reason,
        "scope: ${item.scope}",
        item.resetsAtMs?.let { "resets: $it" },
    ).joinToString("\n")
    NoticeCard("Spend blocked", detail, Red)
}

@Composable
private fun PeerRow(item: FeedItem.Peer) {
    CardContainer(tint = Accent) {
        Text(
            "${item.direction.replaceFirstChar(Char::uppercaseChar)} · ${item.peerLabel}",
            color = Accent,
            style = MaterialTheme.typography.labelSmall,
        )
        Text(item.text, style = MaterialTheme.typography.bodyMedium)
        Text(
            "${item.initiator} · ${item.peerThreadId}",
            color = TextDim,
            style = MaterialTheme.typography.labelSmall,
        )
    }
}

@Composable
private fun TodoRow(item: FeedItem.Todo) {
    CardContainer(tint = Accent) {
        Text("Todo", fontWeight = FontWeight.SemiBold)
        item.items.forEach { todo ->
            val marker = when (todo.status) {
                "completed" -> "[x]"
                "in_progress" -> "[~]"
                else -> "[ ]"
            }
            Text("$marker ${todo.text}", fontFamily = GeistMono, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
private fun NoticeCard(
    title: String,
    body: String,
    tint: androidx.compose.ui.graphics.Color,
    progress: Boolean = false,
) {
    CardContainer(tint) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (progress) {
                CircularProgressIndicator(color = tint, modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                Spacer(Modifier.width(9.dp))
            }
            Text(title, color = tint, fontWeight = FontWeight.SemiBold)
        }
        Text(body, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun CardContainer(
    tint: androidx.compose.ui.graphics.Color,
    content: @Composable ColumnScope.() -> Unit,
) {
    Card(
        colors = CardDefaults.cardColors(containerColor = Surface),
        border = BorderStroke(1.dp, tint.copy(alpha = 0.22f)),
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 7.dp),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(9.dp),
        ) { content() }
    }
}

@Composable
private fun MonoBlock(label: String, text: String) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(SurfaceRaised)
            .padding(10.dp),
    ) {
        Text(label, color = TextDim, style = MaterialTheme.typography.labelSmall)
        Text(text, fontFamily = GeistMono, fontSize = 11.sp)
    }
}

@Composable
private fun PressableLine(
    enabled: Boolean,
    onClick: () -> Unit,
    content: @Composable RowScope.() -> Unit,
) {
    val interactionSource = remember { MutableInteractionSource() }
    val pressed by interactionSource.collectIsPressedAsState()
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(if (pressed && enabled) SurfaceRaised else Surface)
            .clickable(
                enabled = enabled,
                interactionSource = interactionSource,
                indication = null,
                role = if (enabled) Role.Button else null,
                onClick = onClick,
            )
            .padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        content = content,
    )
}

@Composable
private fun FullPageLoading() {
    Column(
        modifier = Modifier.fillMaxSize(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        CircularProgressIndicator(modifier = Modifier.size(28.dp), strokeWidth = 2.dp)
        Text("Loading thread", color = TextDim, modifier = Modifier.padding(top = 16.dp))
    }
}

@Composable
private fun EmptyThread() {
    Column(
        modifier = Modifier.fillMaxSize(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text("No messages yet", style = MaterialTheme.typography.titleMedium)
        Text("This thread has no visible history.", color = TextDim, modifier = Modifier.padding(top = 8.dp))
    }
}

@Composable
private fun FullPageFailure(message: String, onRetry: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text("Could not load thread", style = MaterialTheme.typography.titleMedium)
        Text(message, color = TextDim, modifier = Modifier.padding(top = 8.dp, bottom = 20.dp))
        OutlinedButton(onClick = onRetry, modifier = Modifier.heightIn(min = 48.dp)) {
            Text("Retry")
        }
    }
}
