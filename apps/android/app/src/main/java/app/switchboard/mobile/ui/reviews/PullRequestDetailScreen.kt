package app.switchboard.mobile.ui.reviews

import app.switchboard.mobile.ui.demo.LocalPhoneDemo
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import app.switchboard.mobile.data.remote.PrWriteState
import app.switchboard.mobile.data.remote.PullRequestDetailState
import app.switchboard.mobile.domain.reviews.PhonePrStatusLine
import app.switchboard.mobile.domain.reviews.PhonePullRequests
import app.switchboard.mobile.domain.reviews.PhoneReviewPill
import app.switchboard.mobile.domain.reviews.PrDetail
import app.switchboard.mobile.domain.reviews.PrLinkChat
import app.switchboard.mobile.domain.reviews.WorkOnPr
import app.switchboard.mobile.domain.reviews.WorkOnPrPlace
import app.switchboard.mobile.domain.reviews.WorkOnPrPlan
import app.switchboard.mobile.ui.components.SectionLabel
import app.switchboard.mobile.ui.theme.Accent
import app.switchboard.mobile.ui.theme.Green
import app.switchboard.mobile.ui.theme.OnAccent
import app.switchboard.mobile.ui.theme.Red
import app.switchboard.mobile.ui.theme.Surface
import app.switchboard.mobile.ui.theme.SurfaceRaised
import app.switchboard.mobile.ui.theme.SwitchboardDimensions
import app.switchboard.mobile.ui.theme.TextDim

object PullRequestDetailTestTags {
    const val CHECKS_ROW = "pr-detail-checks"
    const val CHECKS_EXPANDED = "pr-detail-checks-expanded"
    const val ASK_AGENT = "pr-detail-ask-agent"
    const val MERGE_NOTE = "pr-detail-merge-on-desktop"
    const val WORK_ON_PR = "pr-detail-work-on-pr"
    const val OPEN_BROWSER = "pr-detail-open-in-browser"
    const val WORK_SHEET = "pr-detail-work-sheet"
    const val START_CHAT = "pr-detail-start-chat"
    const val ATTACH = "pr-detail-attach"
    const val SHOW_MORE = "pr-detail-show-more"
    fun linkedChat(id: String) = "pr-detail-linked-chat:$id"
    fun pickChat(id: String) = "pr-detail-pick-chat:$id"
}

private const val DESCRIPTION_PREVIEW_CHARS = 280

/** Which chat picker is open: attach the PR as context, or ask about the failed checks. */
private enum class ChatPicker { Attach, AskFailures }

@Composable
@OptIn(ExperimentalMaterial3Api::class)
fun PullRequestDetailScreen(
    state: PullRequestDetailState,
    /** Null while the detail loads or when no project covers the repository. */
    plan: WorkOnPrPlan?,
    now: Long,
    onBack: () -> Unit,
    onRetry: () -> Unit,
    onOpenUrl: (String) -> Unit,
    onOpenChat: (PrLinkChat, PhoneReviewPill?) -> Unit,
    onStartChat: (PrDetail, WorkOnPrPlan) -> Unit,
    onLoadLinkableChats: () -> Unit,
    modifier: Modifier = Modifier,
    /** Null when the backend has no phone writes; the screen is then unchanged. */
    writes: PrWriteState? = null,
    writeActions: PrWriteActions = PrWriteActions(),
) {
    var workSheet by rememberSaveable { mutableStateOf(false) }
    var picker by rememberSaveable { mutableStateOf<ChatPicker?>(null) }
    Column(modifier = modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        TextButton(onClick = onBack, modifier = Modifier.statusBarsPadding().padding(start = 4.dp)) {
            Text("‹ Reviews", color = Accent)
        }
        val detail = state.detail
        if (detail == null) {
            Box(modifier = Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                if (state.error != null) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(24.dp)) {
                        Text(state.error, color = Red, style = MaterialTheme.typography.bodyMedium)
                        TextButton(onClick = onRetry) { Text("Try again", color = Accent) }
                    }
                } else {
                    CircularProgressIndicator(modifier = Modifier.semantics { contentDescription = "Loading pull request" })
                }
            }
            return@Column
        }
        DetailBody(
            detail = detail,
            linkedChats = state.linkedChats,
            now = now,
            writes = writes,
            writeActions = writeActions,
            onOpenChat = { onOpenChat(it, null) },
            onAskAgent = {
                val pill = PhonePullRequests.failedChecksPill(detail) ?: return@DetailBody
                val only = state.linkedChats.singleOrNull()
                if (only != null) {
                    onOpenChat(only, pill)
                } else {
                    onLoadLinkableChats()
                    picker = ChatPicker.AskFailures
                }
            },
            modifier = Modifier.weight(1f),
        )
        PrWriteNotice(writes?.notice, modifier = Modifier.align(Alignment.CenterHorizontally).padding(top = 8.dp))
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Button(
                onClick = { workSheet = true },
                modifier = Modifier
                    .weight(1f)
                    .heightIn(min = 52.dp)
                    .testTag(PullRequestDetailTestTags.WORK_ON_PR),
                shape = RoundedCornerShape(14.dp),
            ) {
                ReviewsGlyphIcon(ReviewsGlyph.Conversation, OnAccent)
                Spacer(Modifier.width(8.dp))
                Text("Work on PR", fontWeight = FontWeight.SemiBold)
            }
            // The demo's pull requests are made up, so there is nothing to open.
            if (!LocalPhoneDemo.current) {
                Spacer(Modifier.width(10.dp))
                Box(
                    modifier = Modifier
                        .size(52.dp)
                        .clip(RoundedCornerShape(14.dp))
                        .background(SurfaceRaised)
                        .clickable { onOpenUrl(detail.summary.url) }
                        .testTag(PullRequestDetailTestTags.OPEN_BROWSER)
                        .semantics { contentDescription = "Open in browser" },
                    contentAlignment = Alignment.Center,
                ) {
                    ReviewsGlyphIcon(ReviewsGlyph.External, MaterialTheme.colorScheme.onSurface)
                }
            }
        }
        if (writes != null) PrWriteOverlays(writes, detail.summary, writeActions)
        if (workSheet) {
            ModalBottomSheet(onDismissRequest = { workSheet = false }, containerColor = Surface) {
                WorkOnPrSheet(
                    detail = detail,
                    linkedChats = state.linkedChats,
                    plan = plan,
                    onOpenChat = {
                        workSheet = false
                        onOpenChat(it, null)
                    },
                    onStartChat = { start ->
                        workSheet = false
                        onStartChat(detail, start)
                    },
                    onAttach = {
                        workSheet = false
                        onLoadLinkableChats()
                        picker = ChatPicker.Attach
                    },
                )
            }
        }
        picker?.let { mode ->
            val pill = when (mode) {
                ChatPicker.Attach -> PhonePullRequests.workOnPrPill(detail, WorkOnPrPlace.Attached)
                ChatPicker.AskFailures -> PhonePullRequests.failedChecksPill(detail)
            }
            ModalBottomSheet(onDismissRequest = { picker = null }, containerColor = Surface) {
                ChatPickerSheet(
                    title = if (mode == ChatPicker.Attach) "Attach to a chat" else "Ask the agent",
                    linked = state.linkedChats,
                    linkable = state.linkableChats,
                    error = state.linkableError,
                    onPick = { chat ->
                        picker = null
                        onOpenChat(chat, pill)
                    },
                )
            }
        }
    }
}

@Composable
private fun DetailBody(
    detail: PrDetail,
    linkedChats: List<PrLinkChat>,
    now: Long,
    writes: PrWriteState?,
    writeActions: PrWriteActions,
    onOpenChat: (PrLinkChat) -> Unit,
    onAskAgent: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val pr = detail.summary
    var checksOpen by rememberSaveable(pr.ref.key) { mutableStateOf(false) }
    var descriptionOpen by rememberSaveable(pr.ref.key) { mutableStateOf(false) }
    Column(
        modifier = modifier
            .verticalScroll(rememberScrollState())
            .padding(horizontal = SwitchboardDimensions.screenHorizontalPadding),
    ) {
        Text(
            pr.title,
            style = MaterialTheme.typography.headlineSmall,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.semantics { heading() },
        )
        Row(modifier = Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            StatePill(pr.state, pr.draft)
            Spacer(Modifier.width(8.dp))
            Mono("${pr.ref.repo.label} #${pr.ref.number}", TextDim)
        }
        Row(modifier = Modifier.padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            ReviewsGlyphIcon(ReviewsGlyph.PullRequest, TextDim, size = 14.dp)
            Spacer(Modifier.width(6.dp))
            Mono(pr.sourceBranch, MaterialTheme.colorScheme.onSurface, background = true)
            Text("  →  ", color = TextDim, style = MaterialTheme.typography.labelSmall)
            Mono(pr.targetBranch, MaterialTheme.colorScheme.onSurface, background = true)
        }
        Row(modifier = Modifier.padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Avatar(pr.author.displayName.ifEmpty { pr.author.login })
            Spacer(Modifier.width(6.dp))
            Text(
                listOf(
                    pr.author.login,
                    "updated ${PhonePullRequests.ageLabel(pr.updatedAt, now)} ago",
                    PhonePullRequests.diffStatLabel(pr),
                ).filter { it.isNotEmpty() }.joinToString(" · "),
                color = TextDim,
                style = MaterialTheme.typography.labelMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }

        Card(modifier = Modifier.padding(top = 16.dp)) {
            StatusRow(
                label = "Checks",
                line = PhonePullRequests.checksStatus(pr.checks),
                chevron = if (checksOpen) Chevron.Down else Chevron.Right,
                modifier = Modifier
                    .clickable { checksOpen = !checksOpen }
                    .testTag(PullRequestDetailTestTags.CHECKS_ROW)
                    .semantics { stateDescription = if (checksOpen) "Expanded" else "Collapsed" },
            )
            if (checksOpen) ChecksList(detail, onAskAgent)
            HorizontalDivider()
            StatusRow("Reviews", PhonePullRequests.reviewsStatus(pr))
            HorizontalDivider()
            StatusRow("Conversations", PhonePullRequests.conversationsStatus(pr))
            HorizontalDivider()
            StatusRow("Conflicts", PhonePullRequests.conflictsStatus(pr))
        }

        val dashColor = MaterialTheme.colorScheme.outlineVariant
        Row(
            modifier = Modifier
                .padding(top = 12.dp)
                .fillMaxWidth()
                .drawBehind {
                    drawRoundRect(
                        dashColor,
                        cornerRadius = CornerRadius(12.dp.toPx()),
                        style = Stroke(1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(8f, 6f))),
                    )
                }
                .padding(14.dp)
                .testTag(PullRequestDetailTestTags.MERGE_NOTE),
        ) {
            ReviewsGlyphIcon(ReviewsGlyph.Lock, TextDim, size = 16.dp)
            Spacer(Modifier.width(10.dp))
            Text(
                buildAnnotatedString {
                    withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append("Merge on desktop. ") }
                    withStyle(SpanStyle(color = TextDim)) { append(PhonePullRequests.mergeOnDesktopNote(pr.ref.host, canWrite = writes?.canWrite == true)) }
                },
                style = MaterialTheme.typography.bodySmall,
            )
        }

        if (detail.description.isNotBlank()) {
            SectionLabel("Description", modifier = Modifier.padding(top = 20.dp, bottom = 8.dp))
            val long = detail.description.length > DESCRIPTION_PREVIEW_CHARS
            val shown = if (long && !descriptionOpen) {
                detail.description.take(DESCRIPTION_PREVIEW_CHARS).trimEnd() + "…"
            } else {
                detail.description
            }
            app.switchboard.mobile.ui.thread.ThreadRichText(markdown = shown)
            if (long) {
                TextButton(
                    onClick = { descriptionOpen = !descriptionOpen },
                    modifier = Modifier.testTag(PullRequestDetailTestTags.SHOW_MORE),
                ) { Text(if (descriptionOpen) "Show less" else "Show more", color = Accent) }
            }
        }

        if (writes != null) PrConversationsSection(writes, pr, writeActions)

        if (linkedChats.isNotEmpty()) {
            SectionLabel("Linked chats", modifier = Modifier.padding(top = 20.dp, bottom = 8.dp))
            Card {
                linkedChats.forEachIndexed { index, chat ->
                    if (index > 0) HorizontalDivider()
                    ChatRow(
                        title = chat.title,
                        subtitle = WorkOnPr.linkedChatSubtitle(chat),
                        onClick = { onOpenChat(chat) },
                        modifier = Modifier.testTag(PullRequestDetailTestTags.linkedChat(chat.id)),
                    )
                }
            }
        }
        Spacer(Modifier.heightIn(min = 16.dp).size(16.dp))
    }
}

@Composable
private fun ChecksList(detail: PrDetail, onAskAgent: () -> Unit) {
    val ordered = PhonePullRequests.orderedChecks(detail.checkList)
    val shown = ordered.take(PhonePullRequests.PHONE_CHECKS_SHOWN)
    val more = PhonePullRequests.moreChecksLabel(ordered.drop(PhonePullRequests.PHONE_CHECKS_SHOWN))
    Column(modifier = Modifier.testTag(PullRequestDetailTestTags.CHECKS_EXPANDED)) {
        shown.forEach { check ->
            HorizontalDivider()
            val (glyph, tint) = checkGlyph(check.state)
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 36.dp, end = 14.dp, top = 9.dp, bottom = 9.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                ReviewsGlyphIcon(glyph, tint, size = 16.dp)
                Spacer(Modifier.width(10.dp))
                Text(check.name, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Text(
                    PhonePullRequests.checkTrailing(check),
                    color = when (check.state) {
                        "failure" -> Red
                        "pending" -> app.switchboard.mobile.ui.theme.Amber
                        else -> TextDim
                    },
                    style = MaterialTheme.typography.labelSmall,
                )
            }
        }
        if (more.isNotEmpty()) {
            HorizontalDivider()
            Text(more, color = TextDim, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(start = 36.dp, top = 9.dp, bottom = 9.dp))
        }
        if (PhonePullRequests.failedChecksPill(detail) != null) {
            HorizontalDivider()
            TextButton(
                onClick = onAskAgent,
                modifier = Modifier.fillMaxWidth().testTag(PullRequestDetailTestTags.ASK_AGENT),
            ) {
                ReviewsGlyphIcon(ReviewsGlyph.Conversation, Accent, size = 16.dp)
                Spacer(Modifier.width(8.dp))
                Text("Ask the agent about the failures", color = Accent)
            }
        }
        HorizontalDivider()
        Row(modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            ReviewsGlyphIcon(ReviewsGlyph.Lock, TextDim, size = 14.dp)
            Spacer(Modifier.width(8.dp))
            Text(PhonePullRequests.RERUN_ON_DESKTOP_NOTE, color = TextDim, style = MaterialTheme.typography.labelSmall)
        }
    }
}

@Composable
private fun WorkOnPrSheet(
    detail: PrDetail,
    linkedChats: List<PrLinkChat>,
    plan: WorkOnPrPlan?,
    onOpenChat: (PrLinkChat) -> Unit,
    onStartChat: (WorkOnPrPlan) -> Unit,
    onAttach: () -> Unit,
) {
    Column(modifier = Modifier.fillMaxWidth().padding(bottom = 24.dp).testTag(PullRequestDetailTestTags.WORK_SHEET)) {
        Text(
            "Work on #${detail.summary.ref.number}",
            style = MaterialTheme.typography.titleLarge,
            modifier = Modifier.padding(horizontal = 16.dp).semantics { heading() },
        )
        if (linkedChats.isNotEmpty()) {
            SectionLabel(if (linkedChats.size == 1) "Linked chat" else "Linked chats", modifier = Modifier.padding(start = 16.dp, top = 16.dp, bottom = 4.dp))
            linkedChats.forEach { chat ->
                ChatRow(chat.title, WorkOnPr.linkedChatSubtitle(chat), onClick = { onOpenChat(chat) })
                HorizontalDivider()
            }
        }
        SectionLabel("New chat", modifier = Modifier.padding(start = 16.dp, top = 16.dp, bottom = 4.dp))
        ChatRow(
            title = buildAnnotatedString {
                append("Start a chat on ")
                withStyle(SpanStyle(fontFamily = FontFamily.Monospace)) { append(detail.summary.sourceBranch) }
            }.toString(),
            subtitle = WorkOnPr.newChatSubtitle(plan),
            enabled = plan != null,
            onClick = { plan?.let(onStartChat) },
            modifier = Modifier.testTag(PullRequestDetailTestTags.START_CHAT),
        )
        HorizontalDivider()
        ChatRow(
            title = "Attach as context to another chat",
            subtitle = "Adds a review pill to its composer",
            onClick = onAttach,
            modifier = Modifier.testTag(PullRequestDetailTestTags.ATTACH),
        )
    }
}

@Composable
private fun ChatPickerSheet(
    title: String,
    linked: List<PrLinkChat>,
    linkable: List<PrLinkChat>?,
    error: String?,
    onPick: (PrLinkChat) -> Unit,
) {
    val chats = remember(linked, linkable) { (linked + linkable.orEmpty()).distinctBy { it.id } }
    Column(modifier = Modifier.fillMaxWidth().padding(bottom = 24.dp)) {
        Text(title, style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(horizontal = 16.dp).semantics { heading() })
        when {
            chats.isEmpty() && linkable == null -> CircularProgressIndicator(modifier = Modifier.padding(24.dp).align(Alignment.CenterHorizontally))
            chats.isEmpty() -> Text(
                error ?: "No chat in this repository's projects yet.",
                color = if (error != null) Red else TextDim,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(16.dp),
            )
            else -> chats.forEach { chat ->
                ChatRow(
                    title = chat.title,
                    subtitle = if (chat.linkSource != null) {
                        WorkOnPr.linkedChatSubtitle(chat)
                    } else {
                        "${WorkOnPr.agentLabel(chat.agentType)} · ${WorkOnPr.projectName(chat.projectPath)}"
                    },
                    onClick = { onPick(chat) },
                    modifier = Modifier.testTag(PullRequestDetailTestTags.pickChat(chat.id)),
                )
                HorizontalDivider()
            }
        }
    }
}

@Composable
private fun ChatRow(
    title: String,
    subtitle: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clickable(enabled = enabled, onClick = onClick)
            .heightIn(min = SwitchboardDimensions.rowMinimumHeight)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                title,
                color = if (enabled) MaterialTheme.colorScheme.onSurface else TextDim,
                style = MaterialTheme.typography.bodyLarge,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(subtitle, color = TextDim, style = MaterialTheme.typography.labelMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        if (enabled) Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = TextDim)
    }
}

private enum class Chevron { None, Right, Down }

@Composable
private fun StatusRow(label: String, line: PhonePrStatusLine, modifier: Modifier = Modifier, chevron: Chevron = Chevron.None) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = SwitchboardDimensions.minimumTouchTarget)
            .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ReviewsGlyphIcon(line.tone.glyph(), line.tone.color(), size = 16.dp)
        Spacer(Modifier.width(10.dp))
        Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        Text(line.text, color = line.tone.color(), style = MaterialTheme.typography.labelMedium, maxLines = 1)
        when (chevron) {
            Chevron.None -> Unit
            Chevron.Right -> Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = TextDim, modifier = Modifier.size(18.dp))
            Chevron.Down -> Icon(Icons.Default.KeyboardArrowDown, contentDescription = null, tint = TextDim, modifier = Modifier.size(18.dp))
        }
    }
}

@Composable
private fun Card(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(SwitchboardDimensions.compactRadius),
        color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Column { content() }
    }
}

@Composable
private fun StatePill(state: String, draft: Boolean) {
    val (label, color) = when {
        state == "merged" -> "Merged" to Accent
        state == "closed" -> "Closed" to Red
        draft -> "Draft" to TextDim
        else -> "Open" to Green
    }
    Text(
        label,
        color = color,
        style = MaterialTheme.typography.labelMedium,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier
            .clip(RoundedCornerShape(50))
            .background(color.copy(alpha = 0.15f))
            .padding(horizontal = 8.dp, vertical = 2.dp),
    )
}

@Composable
private fun Mono(text: String, color: Color, background: Boolean = false) {
    Text(
        text,
        color = color,
        fontFamily = FontFamily.Monospace,
        style = MaterialTheme.typography.labelMedium,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = if (background) {
            Modifier.clip(RoundedCornerShape(4.dp)).background(SurfaceRaised).padding(horizontal = 4.dp, vertical = 1.dp)
        } else {
            Modifier
        },
    )
}

@Composable
private fun Avatar(name: String) {
    val initials = name.split(' ', '-', '_', '.').filter { it.isNotEmpty() }.take(2).joinToString("") { it.take(1) }
        .ifEmpty { name.take(2) }
        .uppercase()
        .take(2)
    Box(
        modifier = Modifier.size(18.dp).clip(CircleShape).background(Accent.copy(alpha = 0.6f)),
        contentAlignment = Alignment.Center,
    ) {
        Text(initials, color = Color.White, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
    }
}
