package app.switchboard.mobile.ui.thread

import android.provider.OpenableColumns
import android.graphics.BitmapFactory
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
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
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.produceState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.platform.LocalContext
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
import app.switchboard.mobile.ui.theme.Accent
import app.switchboard.mobile.ui.theme.Amber
import app.switchboard.mobile.ui.theme.GeistMono
import app.switchboard.mobile.ui.theme.Green
import app.switchboard.mobile.ui.theme.Red
import app.switchboard.mobile.ui.theme.Surface
import app.switchboard.mobile.ui.theme.SurfaceRaised
import app.switchboard.mobile.ui.theme.TextDim
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

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
    val presentation = ThreadPresenter.present(loadState)

    Column(modifier = modifier.fillMaxSize()) {
        ThreadTopBar(title = title, onBack = onBack)
        Box(modifier = Modifier.weight(1f)) {
            when (presentation) {
                ThreadPresentation.Loading -> FullPageLoading()
                is ThreadPresentation.Failure -> FullPageFailure(presentation.message, onRetry)
                is ThreadPresentation.Empty -> Column(Modifier.fillMaxSize()) {
                    ThreadMetadata(presentation.metadata)
                    ContentStatus(presentation.contentStatus, onRetry)
                    EmptyThread()
                }

                is ThreadPresentation.Content -> LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(bottom = 24.dp),
                ) {
                    item(key = "thread-metadata") { ThreadMetadata(presentation.metadata) }
                    item(key = "thread-content-status") {
                        ContentStatus(presentation.contentStatus, onRetry)
                    }
                    items(presentation.rows, key = { "feed:${it.key}" }) { row ->
                        ThreadRow(
                            row = row,
                            backendLabel = backendLabel,
                            selections = selections,
                            onSelectionsChange = { selections = it },
                            pendingActions = pendingActions,
                            onAction = onAction,
                        )
                    }
                    item(key = "navigation-inset") { Spacer(Modifier.navigationBarsPadding()) }
                }
            }
        }
        if (queuedTurns.isNotEmpty()) {
            OutboxTray(queuedTurns, onOutboxAction)
        }
        composer?.let {
            ThreadComposer(
                state = it,
                onDraftChange = onDraftChange,
                onSend = onSend,
                onInterrupt = onInterrupt,
                onRuntimeModeChange = onRuntimeModeChange,
                onClearLocalFeed = onClearLocalFeed,
                skills = skills,
                onImagesSelected = onImagesSelected,
                onRemoveImage = onRemoveImage,
            )
        }
    }
}

@Composable
private fun ThreadComposer(
    state: ThreadComposerPresentation,
    onDraftChange: (String) -> Unit,
    onSend: () -> Unit,
    onInterrupt: () -> Unit,
    onRuntimeModeChange: (RuntimeMode) -> Unit,
    onClearLocalFeed: () -> Unit,
    skills: List<ProviderSkill>,
    onImagesSelected: (List<ComposerImageSource>) -> Unit,
    onRemoveImage: (String) -> Unit,
) {
    val context = LocalContext.current
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
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(Surface)
            .imePadding()
            .navigationBarsPadding()
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            RuntimeMode.entries.forEach { mode ->
                if (mode == state.runtimeMode) {
                    Button(
                        onClick = { onRuntimeModeChange(mode) },
                        enabled = !state.modeChanging,
                        modifier = Modifier.heightIn(min = 48.dp),
                    ) { Text(mode.label()) }
                } else {
                    OutlinedButton(
                        onClick = { onRuntimeModeChange(mode) },
                        enabled = !state.modeChanging,
                        modifier = Modifier.heightIn(min = 48.dp),
                    ) { Text(mode.label()) }
                }
            }
        }
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
        OutlinedTextField(
            value = state.draft,
            onValueChange = onDraftChange,
            modifier = Modifier
                .fillMaxWidth()
                .focusRequester(focusRequester),
            placeholder = {
                Text(if (state.showInterrupt) "Queue a follow-up…" else "Message the agent…")
            },
            minLines = 1,
            maxLines = 5,
        )
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedButton(
                onClick = { imagePicker.launch(arrayOf("image/*")) },
                enabled = state.attachments.size < 4 && !state.submitting,
                modifier = Modifier.heightIn(min = 48.dp),
            ) { Text(if (state.attachments.isEmpty()) "Add images" else "Add image") }
            Spacer(Modifier.weight(1f))
            if (state.showInterrupt) {
                OutlinedButton(
                    onClick = onInterrupt,
                    enabled = !state.interrupting,
                    modifier = Modifier.heightIn(min = 48.dp),
                ) { Text(if (state.interrupting) "Stopping…" else "Stop") }
            }
            Button(
                onClick = onSend,
                enabled = state.canSend,
                modifier = Modifier.heightIn(min = 48.dp),
            ) { Text(if (state.submitting) "Saving…" else "Send") }
        }
    }
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
        TextButton(
            onClick = onRemove,
            modifier = Modifier.align(Alignment.TopEnd),
        ) { Text("×") }
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

private fun RuntimeMode.label(): String = when (this) {
    RuntimeMode.Plan -> "Plan"
    RuntimeMode.Sandbox -> "Sandbox"
    RuntimeMode.AcceptEdits -> "Accept edits"
    RuntimeMode.FullAccess -> "Full access"
}

@Composable
private fun ThreadTopBar(title: String, onBack: () -> Unit) {
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
            text = title,
            style = MaterialTheme.typography.titleMedium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .weight(1f)
                .padding(horizontal = 8.dp),
        )
    }
}

@Composable
private fun ThreadMetadata(metadata: ThreadMetadataPresentation) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 80.dp)
            .padding(horizontal = 20.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            StatusDot(metadata.status)
            MetadataText(metadata.status)
            MetadataText(metadata.provider ?: "provider pending")
            metadata.instanceName?.let { MetadataText(it) }
            Spacer(Modifier.weight(1f))
            MetadataText(metadata.runtimeMode)
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = metadata.contextLabel ?: "Context pending",
                    color = TextDim,
                    style = MaterialTheme.typography.labelSmall,
                )
                metadata.contextFraction?.let { fraction ->
                    LinearProgressIndicator(
                        progress = { fraction },
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(top = 4.dp),
                    )
                }
            }
            metadata.model?.let { MetadataText(it) }
            metadata.costLabel?.let { MetadataText(it) }
            metadata.durationLabel?.let { MetadataText(it) }
            if (metadata.unread > 0) MetadataText("${metadata.unread} unread")
        }
    }
}

@Composable
private fun StatusDot(status: String) {
    val tint = when (status) {
        "running", "idle", "ready" -> Green
        "connecting", "retrying" -> Amber
        "error", "failed" -> Red
        else -> TextDim
    }
    Box(
        modifier = Modifier
            .padding(end = 7.dp)
            .size(8.dp)
            .clip(CircleShape)
            .background(tint),
    )
}

@Composable
private fun MetadataText(text: String) {
    Text(
        text = text,
        color = TextDim,
        fontFamily = GeistMono,
        fontSize = 10.sp,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.padding(end = 10.dp),
    )
}

@Composable
private fun ContentStatus(status: ThreadContentStatus, onRetry: () -> Unit) {
    val tint = when (status.kind) {
        ThreadContentStatusKind.NORMAL -> TextDim
        ThreadContentStatusKind.CACHED -> Accent
        ThreadContentStatusKind.ERROR -> Red
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .padding(start = 20.dp, end = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (status.showProgress) {
            CircularProgressIndicator(
                color = tint,
                strokeWidth = 2.dp,
                modifier = Modifier.size(16.dp),
            )
            Spacer(Modifier.width(10.dp))
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(status.label, color = tint, style = MaterialTheme.typography.labelSmall)
            status.detail?.let {
                Text(
                    text = it,
                    color = TextDim,
                    style = MaterialTheme.typography.labelSmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (status.canRetry) {
            TextButton(onClick = onRetry, modifier = Modifier.heightIn(min = 48.dp)) {
                Text("Retry")
            }
        }
    }
}

@Composable
private fun ThreadRow(
    row: ThreadRowPresentation,
    backendLabel: String,
    selections: QuestionSelections,
    onSelectionsChange: (QuestionSelections) -> Unit,
    pendingActions: ThreadPendingActions,
    onAction: (ThreadUiAction) -> Unit,
) {
    when (row) {
        is ThreadRowPresentation.User -> UserRow(row.source)
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

        is ThreadRowPresentation.FileEdit -> FileEditRow(row, backendLabel, onAction)
        is ThreadRowPresentation.Drift -> NoticeCard(
            "Worktree changed",
            "${row.source.branch}\n${row.source.worktreePath}",
            Amber,
        )

        is ThreadRowPresentation.SpendBlocked -> SpendRow(row.source)
        is ThreadRowPresentation.Peer -> PeerRow(row.source)
        is ThreadRowPresentation.Todo -> TodoRow(row.source)
        is ThreadRowPresentation.RawNotice -> NoticeCard(
            title = "Unsupported event · ${row.eventType}",
            body = "${row.source.text}\n${row.raw}",
            tint = TextDim,
        )
    }
}

@Composable
private fun UserRow(item: FeedItem.User) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 7.dp),
        horizontalArrangement = Arrangement.End,
    ) {
        Text(
            text = item.text,
            color = MaterialTheme.colorScheme.onSurface,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier
                .fillMaxWidth(0.86f)
                .clip(RoundedCornerShape(14.dp))
                .background(SurfaceRaised)
                .padding(14.dp),
        )
    }
}

@Composable
private fun TextRow(row: ThreadRowPresentation.Text) {
    var expanded by rememberSaveable(row.key) { mutableStateOf(false) }
    val reasoning = row.kind == ThreadRowKind.REASONING
    CardContainer(tint = if (row.kind == ThreadRowKind.PLAN_STREAM) Accent else TextDim) {
        if (reasoning) Text("Reasoning", color = TextDim, style = MaterialTheme.typography.labelSmall)
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
    onAction: (ThreadUiAction) -> Unit,
) {
    CardContainer(tint = Green) {
        Text("${row.source.changeKind} ${row.relPath}", fontWeight = FontWeight.SemiBold)
        Row {
            Text("+${row.addedLines}", color = Green, fontFamily = GeistMono)
            Text("-${row.removedLines}", color = Red, fontFamily = GeistMono, modifier = Modifier.padding(start = 10.dp))
            Text("applied on $backendLabel", color = TextDim, modifier = Modifier.padding(start = 10.dp))
        }
        OutlinedButton(
            onClick = { onAction(ThreadInteractionPolicy.openFile(row.source)) },
            modifier = Modifier.heightIn(min = 48.dp),
        ) { Text("Open file") }
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
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 7.dp),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(9.dp),
        ) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .size(width = 28.dp, height = 2.dp)
                    .background(tint),
            )
            content()
        }
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
