package app.switchboard.mobile.ui.thread

import android.content.ClipData
import android.content.ClipboardManager
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
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
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
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.AlertDialog
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
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.collapse
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.expand
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.buildAnnotatedString
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
import app.switchboard.mobile.domain.remote.ForkLineageMetadata
import app.switchboard.mobile.data.thread.ThreadPendingActions
import app.switchboard.mobile.data.thread.ThreadArchiveState
import app.switchboard.mobile.data.thread.ThreadModelState
import app.switchboard.mobile.data.thread.ThreadProfileState
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
    profiles: ThreadProfileState = ThreadProfileState(),
    archive: ThreadArchiveState = ThreadArchiveState(),
    gitContext: GitContextPresentation? = null,
    onModelChange: (String) -> Unit = {},
    onRefreshModels: () -> Unit = {},
    onProfileChange: (String) -> Unit = {},
    onRefreshProfiles: () -> Unit = {},
    onArchive: () -> Unit = {},
    onRefreshGitContext: () -> Unit = {},
    onClearLocalFeed: () -> Unit = {},
    skills: List<ProviderSkill> = emptyList(),
    pendingActions: ThreadPendingActions = ThreadPendingActions(),
    onImagesSelected: (List<ComposerImageSource>) -> Unit = {},
    onRemoveImage: (String) -> Unit = {},
    queuedTurns: List<QueuedTurn> = emptyList(),
    onOutboxAction: (String, OutboxUiAction) -> Unit = { _, _ -> },
    forkMetadata: ForkLineageMetadata? = null,
    onFork: (messageId: String, withWorktree: Boolean) -> Unit = { _, _ -> },
) {
    BackHandler(onBack = onBack)
    var selections by rememberSaveable(threadId) { mutableStateOf(QuestionSelections.empty()) }
    var lightboxUrl by rememberSaveable(threadId) { mutableStateOf<String?>(null) }
    var settingsOpen by rememberSaveable(threadId) { mutableStateOf(false) }
    var forkMessageId by rememberSaveable(threadId) { mutableStateOf<String?>(null) }
    val presentation = remember(loadState) { ThreadPresenter.present(loadState) }
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
            profiles = profiles,
            profileEnabled = metadata?.status?.let { it != "running" && it != "connecting" } == true,
            archive = archive,
            gitContext = gitContext,
            archiveEnabled = ThreadArchivePolicy.canArchive(metadata?.status, archive.archiving),
            onModeSelected = onRuntimeModeChange,
            onModelSelected = onModelChange,
            onRefreshModels = onRefreshModels,
            onProfileSelected = onProfileChange,
            onRefreshProfiles = onRefreshProfiles,
            onArchive = onArchive,
            onRefreshGitContext = onRefreshGitContext,
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
            forkMetadata?.let { ForkLineageBanner(it) }
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
                                onFork = { messageId -> forkMessageId = messageId },
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
    forkMessageId?.let { messageId ->
        Dialog(onDismissRequest = { forkMessageId = null }) {
            Surface(shape = RoundedCornerShape(12.dp), color = SurfaceRaised) {
                Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Fork conversation", style = MaterialTheme.typography.titleMedium)
                    TextButton(onClick = {
                        forkMessageId = null
                        onFork(messageId, false)
                    }) { Text("Fork conversation here") }
                    TextButton(onClick = {
                        forkMessageId = null
                        onFork(messageId, true)
                    }) { Text("Fork into a new worktree from current HEAD") }
                    TextButton(onClick = { forkMessageId = null }) { Text("Cancel") }
                }
            }
        }
    }
}

@Composable
private fun ForkLineageBanner(metadata: ForkLineageMetadata) {
    val resume = if (metadata.resumeMode == "native") "native resume" else "transcript handoff"
    val git = metadata.branch?.let { branch ->
        " · $branch${metadata.baseSha?.let { " from ${it.take(8)}" }.orEmpty()}"
    }.orEmpty()
    Text(
        text = "Forked from ${metadata.parentTitle} · ${metadata.anchorPreview} · $resume$git",
        modifier = Modifier
            .fillMaxWidth()
            .background(Surface)
            .padding(horizontal = 16.dp, vertical = 8.dp)
            .semantics { contentDescription = "Conversation fork lineage. Forked from ${metadata.parentTitle}. $resume." },
        color = TextDim,
        style = MaterialTheme.typography.labelSmall,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
    )
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
        onImagesSelected(
            uris.map { uri ->
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
                    enabled = !state.submitting,
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
    profiles: ThreadProfileState,
    profileEnabled: Boolean,
    archive: ThreadArchiveState,
    archiveEnabled: Boolean,
    gitContext: GitContextPresentation?,
    onModeSelected: (RuntimeMode) -> Unit,
    onModelSelected: (String) -> Unit,
    onRefreshModels: () -> Unit,
    onProfileSelected: (String) -> Unit,
    onRefreshProfiles: () -> Unit,
    onArchive: () -> Unit,
    onRefreshGitContext: () -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    BackHandler(onBack = onBack)
    var confirmArchive by rememberSaveable { mutableStateOf(false) }
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
            gitContext?.let { context ->
                SectionLabel(
                    text = "Workspace",
                    modifier = Modifier.padding(
                        start = SwitchboardDimensions.screenHorizontalPadding,
                        end = SwitchboardDimensions.screenHorizontalPadding,
                        top = 20.dp,
                        bottom = 8.dp,
                    ),
                )
                SwitchboardListRow(
                    title = context.branchLabel,
                    supportingText = buildString {
                        append(context.checkoutLabel)
                        append(" · ")
                        append(context.checkoutPath)
                        context.parentProjectPath?.let { parent ->
                            append("\nParent · ")
                            append(parent)
                        }
                    },
                    showDivider = false,
                    trailingContent = if (context.loading) {
                        {
                            CircularProgressIndicator(
                                modifier = Modifier.size(20.dp),
                                strokeWidth = 2.dp,
                            )
                        }
                    } else {
                        null
                    },
                )
                context.error?.let { error ->
                    InlineStatus(
                        message = "Could not refresh branch",
                        detail = error,
                        tone = StatusTone.WARNING,
                        actionLabel = "Retry",
                        onAction = onRefreshGitContext,
                        modifier = Modifier.padding(
                            horizontal = SwitchboardDimensions.screenHorizontalPadding,
                            vertical = 8.dp,
                        ),
                    )
                }
            }
            if (profiles.loading) {
                InlineStatus(
                    message = "Loading profiles",
                    tone = StatusTone.INFO,
                    progress = InlineStatusProgress.Indeterminate,
                    modifier = Modifier.padding(
                        horizontal = SwitchboardDimensions.screenHorizontalPadding,
                        vertical = 12.dp,
                    ),
                )
            } else if (profiles.options.isNotEmpty()) {
                SectionLabel(
                    text = "Profile",
                    modifier = Modifier.padding(
                        start = SwitchboardDimensions.screenHorizontalPadding,
                        end = SwitchboardDimensions.screenHorizontalPadding,
                        top = 20.dp,
                        bottom = 8.dp,
                    ),
                )
                profiles.options.forEachIndexed { index, profile ->
                    SwitchboardListRow(
                        title = profile.displayName.ifBlank { profile.id },
                        supportingText = profile.authMode.replace('_', ' '),
                        onClick = if (profileEnabled && !profiles.changing) {
                            ({ onProfileSelected(profile.id) })
                        } else {
                            null
                        },
                        showDivider = index != profiles.options.lastIndex,
                        trailingContent = {
                            RadioButton(
                                selected = profile.id == profiles.selectedInstanceId,
                                onClick = null,
                                enabled = profileEnabled && !profiles.changing,
                            )
                        },
                    )
                }
            }
            profiles.error?.let { error ->
                InlineStatus(
                    message = "Could not switch profile",
                    detail = error,
                    tone = StatusTone.ERROR,
                    actionLabel = "Refresh",
                    onAction = onRefreshProfiles,
                    modifier = Modifier.padding(
                        horizontal = SwitchboardDimensions.screenHorizontalPadding,
                        vertical = 12.dp,
                    ),
                )
            }
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
            SectionLabel(
                text = "Conversation",
                modifier = Modifier.padding(
                    start = SwitchboardDimensions.screenHorizontalPadding,
                    end = SwitchboardDimensions.screenHorizontalPadding,
                    top = 12.dp,
                    bottom = 8.dp,
                ),
            )
            SwitchboardListRow(
                title = if (archive.archiving) "Archiving conversation" else "Archive conversation",
                supportingText = "Remove it from active lists without deleting its history.",
                onClick = if (archiveEnabled) ({ confirmArchive = true }) else null,
                showDivider = false,
                modifier = Modifier.testTag(ThreadTestTags.ARCHIVE_ACTION),
                trailingContent = if (archive.archiving) {
                    {
                        CircularProgressIndicator(
                            modifier = Modifier.size(20.dp),
                            strokeWidth = 2.dp,
                        )
                    }
                } else {
                    null
                },
            )
            archive.error?.let { error ->
                InlineStatus(
                    message = "Could not archive conversation",
                    detail = error,
                    tone = StatusTone.ERROR,
                    modifier = Modifier.padding(
                        horizontal = SwitchboardDimensions.screenHorizontalPadding,
                        vertical = 12.dp,
                    ),
                )
            }
        }
    }
    if (confirmArchive) {
        AlertDialog(
            onDismissRequest = { confirmArchive = false },
            title = { Text("Archive this conversation?") },
            text = { Text("It will leave active lists, but its history and local cached copy will be kept.") },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmArchive = false
                        onArchive()
                    },
                    colors = ButtonDefaults.textButtonColors(
                        contentColor = MaterialTheme.colorScheme.error,
                    ),
                    modifier = Modifier.testTag(ThreadTestTags.ARCHIVE_CONFIRM),
                ) {
                    Text("Archive")
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmArchive = false }) {
                    Text("Cancel")
                }
            },
        )
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
    onFork: (String) -> Unit,
) {
    when (row) {
        is ThreadRowPresentation.User -> UserRow(
            row.source,
            onImageOpen,
            onFork.takeIf { row.source.id.startsWith("h-") },
        )
        is ThreadRowPresentation.Text -> TextRow(
            row,
            onFork.takeIf { row.source.id.startsWith("h-") },
        )
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
private fun UserRow(
    item: FeedItem.User,
    onImageOpen: (String) -> Unit,
    onFork: ((String) -> Unit)? = null,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .combinedClickable(
                enabled = onFork != null,
                onClick = {},
                onLongClick = { onFork?.invoke(item.id.removePrefix("h-")) },
            )
            .padding(horizontal = 16.dp, vertical = 7.dp),
        horizontalArrangement = Arrangement.End,
    ) {
        Box(
            modifier = Modifier.fillMaxWidth(0.86f),
            contentAlignment = Alignment.CenterEnd,
        ) {
            Column(
                modifier = Modifier
                    .wrapContentWidth()
                    .clip(MaterialTheme.shapes.medium)
                    .background(MaterialTheme.colorScheme.primary)
                    .padding(horizontal = 14.dp, vertical = 11.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                if (item.text.isNotBlank()) {
                    UserMessageBody(item)
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
}

@Composable
private fun UserMessageBody(item: FeedItem.User) {
    val segments = remember(item.text, item.pillsMeta) {
        PillBodyPresenter.parse(item.text, item.pillsMeta)
    }
    val inlineKeys = segments.mapIndexedNotNull { index, segment ->
        (segment as? PillBodySegment.Pill)?.let { index to it }
    }
    val body = remember(segments) {
        buildAnnotatedString {
            segments.forEachIndexed { index, segment ->
                when (segment) {
                    is PillBodySegment.Text -> append(segment.value)
                    is PillBodySegment.Pill -> appendInlineContent(
                        id = "message-pill-$index",
                        alternateText = segment.label,
                    )
                }
            }
        }
    }
    val inlineContent = inlineKeys.associate { (index, pill) ->
        val width = (pill.label.length * 7 + 24).coerceIn(48, 180).sp
        "message-pill-$index" to InlineTextContent(
            placeholder = Placeholder(
                width = width,
                height = 22.sp,
                placeholderVerticalAlign = PlaceholderVerticalAlign.Center,
            ),
        ) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .clip(RoundedCornerShape(6.dp))
                    .background(MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.14f))
                    .semantics { contentDescription = "Context: ${pill.label}" },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = pill.label,
                    color = MaterialTheme.colorScheme.onPrimary,
                    style = MaterialTheme.typography.labelSmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(horizontal = 7.dp),
                )
            }
        }
    }

    Text(
        text = body,
        inlineContent = inlineContent,
        color = MaterialTheme.colorScheme.onPrimary,
        style = MaterialTheme.typography.bodyMedium,
    )
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
private fun TextRow(
    row: ThreadRowPresentation.Text,
    onFork: ((String) -> Unit)? = null,
) {
    var expanded by rememberSaveable(row.key) { mutableStateOf(false) }
    val reasoning = row.kind == ThreadRowKind.REASONING
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .combinedClickable(
                enabled = onFork != null,
                onClick = {},
                onLongClick = { onFork?.invoke(row.source.messageId) },
            )
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
    var expanded by rememberSaveable(row.key) { mutableStateOf(false) }
    val interactionSource = remember { MutableInteractionSource() }
    val pressed by interactionSource.collectIsPressedAsState()
    val toggle = { expanded = !expanded }
    val accessibilityLabel = listOf(row.label, row.detail)
        .filter(String::isNotBlank)
        .joinToString(", ")
    val interactionModifier = if (row.hasOutput) {
        Modifier.clickable(
            interactionSource = interactionSource,
            indication = null,
            role = Role.Button,
            onClickLabel = if (expanded) "Hide output" else "Show output",
            onClick = toggle,
        )
    } else {
        Modifier
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp)
            .testTag(ThreadTestTags.toolContainer(row.key)),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = ToolActivityLayoutPolicy.CollapsedRowHeightDp.dp)
                .clip(RoundedCornerShape(6.dp))
                .background(if (pressed) SurfaceRaised else Color.Transparent)
                .then(interactionModifier)
                .semantics(mergeDescendants = true) {
                    contentDescription = accessibilityLabel
                    stateDescription = when (row.activityState) {
                        ToolActivityState.RUNNING -> "Running"
                        ToolActivityState.COMPLETED -> if (row.hasOutput) {
                            if (expanded) "Completed, expanded" else "Completed, collapsed"
                        } else {
                            "Completed"
                        }
                    }
                    if (row.hasOutput) {
                        if (expanded) {
                            collapse {
                                toggle()
                                true
                            }
                        } else {
                            expand {
                                toggle()
                                true
                            }
                        }
                    }
                }
                .testTag(ThreadTestTags.toolRow(row.key)),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .width(24.dp)
                    .height(ToolActivityLayoutPolicy.CollapsedRowHeightDp.dp)
                    .clearAndSetSemantics { }
                    .testTag(ThreadTestTags.toolStatus(row.key)),
                contentAlignment = Alignment.CenterStart,
            ) {
                if (row.activityState == ToolActivityState.RUNNING) {
                    CircularProgressIndicator(
                        color = Accent,
                        modifier = Modifier.size(15.dp),
                        strokeWidth = 2.dp,
                    )
                } else {
                    Text(
                        text = toolGlyph(row.iconKind),
                        color = Green.copy(alpha = 0.78f),
                        fontFamily = GeistMono,
                        fontSize = 12.sp,
                        maxLines = 1,
                    )
                }
            }
            Text(
                text = row.label,
                fontWeight = FontWeight.SemiBold,
                style = MaterialTheme.typography.bodySmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .widthIn(max = 112.dp)
                    .testTag(ThreadTestTags.toolLabel(row.key)),
            )
            Spacer(Modifier.width(8.dp))
            Text(
                text = row.detail,
                color = TextDim,
                fontFamily = if (row.monospaceDetail) GeistMono else null,
                style = MaterialTheme.typography.bodySmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .weight(1f)
                    .testTag(ThreadTestTags.toolDetail(row.key)),
            )
            if (row.hasOutput) {
                Box(
                    modifier = Modifier
                        .width(24.dp)
                        .height(ToolActivityLayoutPolicy.CollapsedRowHeightDp.dp)
                        .clearAndSetSemantics { }
                        .testTag(ThreadTestTags.toolDisclosure(row.key)),
                    contentAlignment = Alignment.CenterEnd,
                ) {
                    Text(
                        text = if (expanded) "⌃" else "⌄",
                        color = TextDim,
                        fontSize = 14.sp,
                    )
                }
            }
        }
        if (expanded && row.hasOutput) {
            val output = row.output.orEmpty()
            val outputPages = remember(output) { ToolOutputPresenter.pages(output) }
            val context = LocalContext.current
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(SurfaceRaised)
                    .padding(horizontal = 10.dp, vertical = 9.dp)
                    .testTag(ThreadTestTags.toolOutput(row.key)),
            ) {
                LazyColumn(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(max = 320.dp)
                        .testTag(ThreadTestTags.toolOutputList(row.key)),
                ) {
                    items(
                        count = outputPages.pageCount,
                        key = { page -> page },
                    ) { page ->
                        SelectionContainer {
                            Text(
                                text = outputPages.page(page),
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                fontFamily = GeistMono,
                                fontSize = 11.sp,
                            )
                        }
                    }
                }
                TextButton(
                    onClick = {
                        context.getSystemService(ClipboardManager::class.java)
                            .setPrimaryClip(ClipData.newPlainText("Tool output", output))
                    },
                    modifier = Modifier.heightIn(min = 48.dp),
                ) {
                    Text("Copy full output")
                }
            }
        }
    }
}

private fun toolGlyph(kind: ToolIconKind): String = when (kind) {
    ToolIconKind.SHELL -> ">_"
    ToolIconKind.READ -> "▤"
    ToolIconKind.WRITE -> "+"
    ToolIconKind.EDIT -> "✎"
    ToolIconKind.SEARCH -> "⌕"
    ToolIconKind.FILES -> "▣"
    ToolIconKind.WEB -> "◎"
    ToolIconKind.TASK -> "✦"
    ToolIconKind.NOTEBOOK -> "▦"
    ToolIconKind.TODO -> "✓"
    ToolIconKind.OTHER -> "◇"
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
    var expanded by rememberSaveable(row.key) { mutableStateOf(false) }
    CardContainer(tint = Green) {
        PressableLine(
            enabled = row.diff.lines.isNotEmpty(),
            onClick = { expanded = !expanded },
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    row.relPath,
                    fontWeight = FontWeight.SemiBold,
                    fontFamily = GeistMono,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    val approximation = if (row.diff.countsExact) "" else "~"
                    Text("$approximation+${row.addedLines}", color = Green, fontFamily = GeistMono)
                    Text("$approximation-${row.removedLines}", color = Red, fontFamily = GeistMono)
                    Text(
                        "Changed on $backendLabel · ${row.source.changeKind}",
                        color = TextDim,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            if (row.diff.lines.isNotEmpty()) {
                Text(
                    if (expanded) "Hide" else "Review",
                    color = Accent,
                    style = MaterialTheme.typography.labelMedium,
                    modifier = Modifier.padding(start = 12.dp),
                )
            }
        }
        if (expanded) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(8.dp))
                    .background(SurfaceRaised),
            ) {
                row.diff.lines.forEach { line -> CompactDiffRow(line) }
            }
            Text(
                if (row.diff.truncated) {
                    "Read-only preview · large diff truncated"
                } else {
                    "Read-only preview"
                },
                color = TextDim,
                style = MaterialTheme.typography.labelSmall,
            )
        }
    }
}

@Composable
private fun CompactDiffRow(line: CompactDiffLine) {
    val marker = when (line.kind) {
        DiffLineKind.Added -> "+"
        DiffLineKind.Removed -> "-"
        DiffLineKind.Context -> " "
        DiffLineKind.Omitted -> "…"
    }
    val tint = when (line.kind) {
        DiffLineKind.Added -> Green.copy(alpha = 0.09f)
        DiffLineKind.Removed -> Red.copy(alpha = 0.09f)
        else -> Color.Transparent
    }
    val textColor = when (line.kind) {
        DiffLineKind.Added -> Green
        DiffLineKind.Removed -> Red
        DiffLineKind.Omitted -> TextDim
        DiffLineKind.Context -> MaterialTheme.colorScheme.onSurface
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(tint)
            .padding(horizontal = 8.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            line.oldLine?.toString().orEmpty(),
            color = TextDim,
            fontFamily = GeistMono,
            fontSize = 10.sp,
            textAlign = androidx.compose.ui.text.style.TextAlign.End,
            modifier = Modifier.width(28.dp),
        )
        Text(
            line.newLine?.toString().orEmpty(),
            color = TextDim,
            fontFamily = GeistMono,
            fontSize = 10.sp,
            textAlign = androidx.compose.ui.text.style.TextAlign.End,
            modifier = Modifier.width(28.dp),
        )
        Text(
            marker,
            color = textColor,
            fontFamily = GeistMono,
            modifier = Modifier.padding(horizontal = 7.dp),
        )
        Text(
            line.text,
            color = textColor,
            fontFamily = GeistMono,
            fontSize = 11.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
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
