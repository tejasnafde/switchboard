package app.switchboard.mobile.ui.reviews

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SheetValue
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.switchboard.mobile.data.remote.PrWritePhase
import app.switchboard.mobile.data.remote.PrWriteRules
import app.switchboard.mobile.data.remote.PrWriteSheetState
import app.switchboard.mobile.data.remote.PrWriteState
import app.switchboard.mobile.data.remote.PrWriteTarget
import app.switchboard.mobile.domain.reviews.PhonePrWrites
import app.switchboard.mobile.domain.reviews.PrConversation
import app.switchboard.mobile.domain.reviews.PrSummary
import app.switchboard.mobile.domain.reviews.ReviewEvent
import app.switchboard.mobile.ui.components.SectionLabel
import app.switchboard.mobile.ui.theme.Accent
import app.switchboard.mobile.ui.theme.Amber
import app.switchboard.mobile.ui.theme.Green
import app.switchboard.mobile.ui.theme.Red
import app.switchboard.mobile.ui.theme.Surface
import app.switchboard.mobile.ui.theme.SurfaceRaised
import app.switchboard.mobile.ui.theme.TextDim
import kotlinx.coroutines.delay

object PrWriteTestTags {
    const val SECTION = "pr-writes-conversations"
    const val NO_SCOPE = "pr-writes-no-scope"
    const val COMMENT = "pr-writes-comment"
    const val REVIEW = "pr-writes-review"
    const val COMPOSER_FIELD = "pr-writes-composer-field"
    const val COMPOSER_POST = "pr-writes-composer-post"
    const val SHEET = "pr-writes-sheet"
    const val SHEET_POST = "pr-writes-sheet-post"
    const val CHECK_THREAD = "pr-writes-check-thread"
    const val NOTICE = "pr-writes-notice"
    fun reply(id: String) = "pr-writes-reply:$id"
    fun resolve(id: String) = "pr-writes-resolve:$id"
}

/** What the write UI calls; every action goes to [app.switchboard.mobile.data.remote.PrWriteCoordinator]. */
data class PrWriteActions(
    val onCompose: (PrWriteTarget) -> Unit = {},
    val onCloseComposer: () -> Unit = {},
    val onDraft: (String) -> Unit = {},
    val onReviewEvent: (ReviewEvent) -> Unit = {},
    val onConfirmComposer: () -> Unit = {},
    val onResolve: (PrConversation) -> Unit = {},
    val onDismissSheet: () -> Unit = {},
    /** Post on the sheet: runs the device check, then sends. */
    val onPost: () -> Unit = {},
    val onCheckThread: () -> Unit = {},
    val onClearNotice: () -> Unit = {},
)

private const val COMMENT_PREVIEW_CHARS = 280

/** The thread list under the pull request. Read-only, with a lock note, unless the phone holds `pr-write`. */
@Composable
internal fun PrConversationsSection(state: PrWriteState, pr: PrSummary, actions: PrWriteActions) {
    if (!state.supported) return
    Column(modifier = Modifier.testTag(PrWriteTestTags.SECTION)) {
        SectionLabel("Conversations", modifier = Modifier.padding(top = 20.dp, bottom = 8.dp))
        val conversations = state.conversations
        when {
            conversations == null && state.conversationsError != null ->
                Text(state.conversationsError, color = Red, style = MaterialTheme.typography.bodySmall)
            conversations == null -> CircularProgressIndicator(modifier = Modifier.size(20.dp))
            conversations.isEmpty() -> Text("No conversations yet.", color = TextDim, style = MaterialTheme.typography.bodySmall)
            else -> conversations.forEach { conversation ->
                ConversationCard(conversation, state.canWrite, actions)
                Spacer(Modifier.size(8.dp))
            }
        }
        if (state.canWrite) {
            Row(modifier = Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedButton(
                    onClick = { actions.onCompose(PrWriteTarget.Comment) },
                    modifier = Modifier.weight(1f).testTag(PrWriteTestTags.COMMENT),
                ) { Text("Comment") }
                Button(
                    onClick = {
                        val events = PhonePrWrites.phoneReviewEvents(pr)
                        actions.onCompose(PrWriteTarget.Review(if (ReviewEvent.Approve in events) ReviewEvent.Approve else ReviewEvent.Comment))
                    },
                    modifier = Modifier.weight(1f).testTag(PrWriteTestTags.REVIEW),
                ) { Text("Review") }
            }
        } else {
            NoScopeNote()
        }
    }
}

@Composable
private fun NoScopeNote() {
    Row(
        modifier = Modifier
            .padding(top = 4.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(SurfaceRaised)
            .padding(14.dp)
            .testTag(PrWriteTestTags.NO_SCOPE),
    ) {
        ReviewsGlyphIcon(ReviewsGlyph.Lock, TextDim, size = 16.dp)
        Spacer(Modifier.width(10.dp))
        Column {
            Text(PhonePrWrites.Copy.NO_SCOPE_TITLE, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Bold)
            Text(PhonePrWrites.Copy.NO_SCOPE_BODY, style = MaterialTheme.typography.bodySmall, color = TextDim)
        }
    }
}

@Composable
private fun ConversationCard(conversation: PrConversation, canWrite: Boolean, actions: PrWriteActions) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Column {
            Row(modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    conversation.location,
                    fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.labelMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                val state = listOfNotNull(
                    if (conversation.resolved) "Resolved" else "Open",
                    "Outdated".takeIf { conversation.outdated },
                ).joinToString(" · ")
                Text(state, color = if (conversation.resolved) Green else Amber, style = MaterialTheme.typography.labelSmall)
            }
            conversation.comments.forEach { comment ->
                HorizontalDivider()
                CommentBody(comment.author.login.ifEmpty { comment.author.displayName }, comment.body)
            }
            if (canWrite && !conversation.resolved) {
                HorizontalDivider()
                Row(modifier = Modifier.padding(horizontal = 4.dp)) {
                    TextButton(
                        onClick = { actions.onCompose(PrWriteTarget.Reply(conversation)) },
                        modifier = Modifier.testTag(PrWriteTestTags.reply(conversation.id)),
                    ) { Text("Reply", color = Accent) }
                    TextButton(
                        onClick = { actions.onResolve(conversation) },
                        modifier = Modifier.testTag(PrWriteTestTags.resolve(conversation.id)),
                    ) { Text("Resolve", color = Accent) }
                }
            }
        }
    }
}

@Composable
private fun CommentBody(author: String, body: String) {
    var open by rememberSaveable(body) { mutableStateOf(false) }
    val long = body.length > COMMENT_PREVIEW_CHARS
    Column(modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp)) {
        Text(author, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
        Text(
            if (long && !open) body.take(COMMENT_PREVIEW_CHARS).trimEnd() + "…" else body,
            style = MaterialTheme.typography.bodySmall,
        )
        if (long) {
            TextButton(onClick = { open = !open }) { Text(if (open) "Show less" else "Show more", color = Accent) }
        }
    }
}

/** The composer, or the confirm sheet over it, and the short notice after a write. */
@Composable
@OptIn(ExperimentalMaterial3Api::class)
internal fun PrWriteOverlays(state: PrWriteState, pr: PrSummary, actions: PrWriteActions) {
    val sheet = state.sheet
    val composer = state.composer
    if (sheet != null) {
        val busy = sheet.phase == PrWritePhase.Authenticating || sheet.phase == PrWritePhase.Posting
        val currentBusy by rememberUpdatedState(busy)
        val sheetState = rememberModalBottomSheetState(
            skipPartiallyExpanded = true,
            confirmValueChange = { it != SheetValue.Hidden || !currentBusy },
        )
        ModalBottomSheet(onDismissRequest = actions.onDismissSheet, sheetState = sheetState, containerColor = Surface) {
            ConfirmSheet(sheet, pr, actions)
        }
    } else if (composer != null) {
        val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        ModalBottomSheet(onDismissRequest = actions.onCloseComposer, sheetState = sheetState, containerColor = Surface) {
            Composer(composer, state.draft(composer), pr, actions)
        }
    }
    state.notice?.let { notice ->
        LaunchedEffect(notice) {
            delay(3_000)
            actions.onClearNotice()
        }
    }
}

@Composable
internal fun PrWriteNotice(notice: String?, modifier: Modifier = Modifier) {
    if (notice == null) return
    Text(
        notice,
        color = MaterialTheme.colorScheme.onSurface,
        style = MaterialTheme.typography.bodyMedium,
        modifier = modifier
            .clip(RoundedCornerShape(10.dp))
            .background(SurfaceRaised)
            .padding(horizontal = 16.dp, vertical = 10.dp)
            .testTag(PrWriteTestTags.NOTICE)
            .semantics { liveRegion = LiveRegionMode.Polite },
    )
}

@Composable
private fun Composer(target: PrWriteTarget, draft: String, pr: PrSummary, actions: PrWriteActions) {
    val text = draft.trim()
    val offered = target.event == null || target.event in PhonePrWrites.phoneReviewEvents(pr)
    val problem = PrWriteRules.composerProblem(pr.ref.host, target, text) ?: if (offered) null else "This verdict is no longer offered."
    val limitNote = PhonePrWrites.prTextLimitNote(pr.ref.host, text.length)
    Column(modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 24.dp)) {
        Text(
            when (target) {
                is PrWriteTarget.Reply -> "Reply on ${target.conversation.location}"
                is PrWriteTarget.Review -> "Review #${pr.ref.number}"
                else -> "Comment on #${pr.ref.number}"
            },
            style = MaterialTheme.typography.titleLarge,
            modifier = Modifier.semantics { heading() },
        )
        if (target is PrWriteTarget.Review) {
            Row(modifier = Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PhonePrWrites.phoneReviewEvents(pr).forEach { event ->
                    FilterChip(
                        selected = event == target.event,
                        onClick = { actions.onReviewEvent(event) },
                        label = { Text(event.label) },
                    )
                }
            }
        }
        OutlinedTextField(
            value = draft,
            onValueChange = actions.onDraft,
            modifier = Modifier.fillMaxWidth().padding(top = 12.dp).heightIn(min = 120.dp, max = 280.dp).testTag(PrWriteTestTags.COMPOSER_FIELD),
            placeholder = {
                Text(
                    when (target) {
                        is PrWriteTarget.Reply -> "Reply to ${target.conversation.comments.lastOrNull()?.author?.login ?: "the thread"}"
                        is PrWriteTarget.Review -> "Summary"
                        else -> "Comment"
                    },
                )
            },
            isError = limitNote != null,
        )
        Row(modifier = Modifier.fillMaxWidth().padding(top = 4.dp)) {
            Text(
                limitNote ?: "",
                color = Red,
                style = MaterialTheme.typography.labelSmall,
                modifier = Modifier.weight(1f),
            )
            Text(characters(text.length), color = TextDim, style = MaterialTheme.typography.labelSmall)
        }
        if (problem != null && limitNote == null && target is PrWriteTarget.Review && text.isNotEmpty()) {
            Text(problem, color = TextDim, style = MaterialTheme.typography.labelSmall)
        }
        Row(modifier = Modifier.fillMaxWidth().padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedButton(onClick = actions.onCloseComposer, modifier = Modifier.weight(1f)) { Text("Cancel") }
            Button(
                onClick = actions.onConfirmComposer,
                enabled = problem == null,
                modifier = Modifier.weight(1f).testTag(PrWriteTestTags.COMPOSER_POST),
            ) { Text("Post") }
        }
    }
}

@Composable
private fun ConfirmSheet(sheet: PrWriteSheetState, pr: PrSummary, actions: PrWriteActions) {
    val target = sheet.target
    val uncertain = sheet.phase == PrWritePhase.Uncertain
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 16.dp, end = 16.dp, bottom = 24.dp)
            .testTag(PrWriteTestTags.SHEET),
    ) {
        Text(
            if (uncertain) PhonePrWrites.Copy.NOT_SURE_TITLE else PrWriteRules.sheetTitle(target),
            style = MaterialTheme.typography.titleLarge,
            modifier = Modifier.semantics { heading() },
        )
        if (uncertain) {
            Text(PhonePrWrites.Copy.NOT_SURE_BODY, color = TextDim, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 6.dp))
        }
        Fact("Account") {
            when {
                sheet.account != null -> Text(sheet.account, style = MaterialTheme.typography.bodyMedium)
                sheet.accountError != null -> Text(sheet.accountError, color = Red, style = MaterialTheme.typography.bodySmall)
                else -> CircularProgressIndicator(modifier = Modifier.size(16.dp).semantics { contentDescription = "Reading the account" })
            }
        }
        Fact("Pull request") {
            Text("${pr.ref.repo.label} #${pr.ref.number}", fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
            Text(pr.title, color = TextDim, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        target.conversation?.let { conversation ->
            Fact("Thread") {
                Text(conversation.location, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
                conversation.comments.lastOrNull()?.let { last ->
                    Text(
                        "${last.author.login}: ${last.body}",
                        color = TextDim,
                        style = MaterialTheme.typography.bodySmall,
                        maxLines = 3,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
        target.event?.let { event -> Fact("Verdict") { Text(event.label, style = MaterialTheme.typography.bodyMedium) } }
        if (target !is PrWriteTarget.Resolve) {
            Row(modifier = Modifier.fillMaxWidth().padding(top = 12.dp)) {
                Text(if (uncertain) "Your text, kept" else "Text", color = TextDim, style = MaterialTheme.typography.labelMedium, modifier = Modifier.weight(1f))
                Text(characters(sheet.text.length), color = TextDim, style = MaterialTheme.typography.labelMedium)
            }
            Text(
                sheet.text.ifEmpty { "No text." },
                color = if (sheet.text.isEmpty()) TextDim else MaterialTheme.colorScheme.onSurface,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier
                    .padding(top = 4.dp)
                    .fillMaxWidth()
                    .heightIn(max = 220.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(SurfaceRaised)
                    .verticalScroll(rememberScrollState())
                    .padding(10.dp),
            )
        }
        if (target.event == ReviewEvent.Approve && !uncertain) {
            Text(PhonePrWrites.Copy.APPROVE_NOTE, color = TextDim, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp))
        }
        when (sheet.phase) {
            PrWritePhase.Refused -> Banner(sheet.message ?: "Did not post.", Red)
            PrWritePhase.Removed -> Banner(PhonePrWrites.Copy.REMOVED, Red)
            PrWritePhase.NoPasscode -> Banner(PhonePrWrites.Copy.NO_PASSCODE, Amber)
            else -> Unit
        }
        Row(modifier = Modifier.fillMaxWidth().padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            val busy = sheet.phase == PrWritePhase.Authenticating || sheet.phase == PrWritePhase.Posting
            OutlinedButton(onClick = actions.onDismissSheet, enabled = !busy, modifier = Modifier.weight(1f)) { Text("Cancel") }
            when {
                uncertain -> Button(
                    onClick = actions.onCheckThread,
                    modifier = Modifier.weight(1f).testTag(PrWriteTestTags.CHECK_THREAD),
                ) { Text("Check thread") }
                sheet.phase != PrWritePhase.Removed -> Button(
                    onClick = actions.onPost,
                    // A re-read may show the pull request closed, or the viewer as its author.
                    enabled = sheet.canPost && (target.event == null || target.event in PhonePrWrites.phoneReviewEvents(pr)),
                    modifier = Modifier.weight(1f).testTag(PrWriteTestTags.SHEET_POST),
                ) {
                    if (busy) {
                        CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.width(8.dp))
                        Text(if (sheet.phase == PrWritePhase.Posting) "Posting" else "Checking")
                    } else {
                        Text(PrWriteRules.primaryLabel(target))
                    }
                }
            }
        }
    }
}

@Composable
private fun Fact(key: String, value: @Composable () -> Unit) {
    Row(modifier = Modifier.fillMaxWidth().padding(top = 12.dp)) {
        Text(key, color = TextDim, style = MaterialTheme.typography.labelMedium, modifier = Modifier.width(96.dp))
        Column(modifier = Modifier.weight(1f)) { value() }
    }
}

@Composable
private fun Banner(text: String, color: Color) {
    Text(
        text,
        color = color,
        style = MaterialTheme.typography.bodySmall,
        modifier = Modifier
            .padding(top = 12.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(color.copy(alpha = 0.12f))
            .padding(10.dp)
            .semantics { liveRegion = LiveRegionMode.Polite },
    )
}

private fun characters(count: Int): String =
    if (count == 1) "1 character" else "${String.format(java.util.Locale.US, "%,d", count)} characters"
