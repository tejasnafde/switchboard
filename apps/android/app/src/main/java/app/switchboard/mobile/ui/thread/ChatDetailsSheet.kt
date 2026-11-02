package app.switchboard.mobile.ui.thread

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import app.switchboard.mobile.data.remote.ChatDetailsState
import app.switchboard.mobile.domain.reviews.PrListData
import app.switchboard.mobile.domain.thread.ChangesValue
import app.switchboard.mobile.domain.thread.ChatDetails
import app.switchboard.mobile.domain.thread.DetailsValue
import app.switchboard.mobile.domain.thread.LeftTone
import app.switchboard.mobile.domain.thread.PrLink
import app.switchboard.mobile.domain.thread.UsageBar
import app.switchboard.mobile.ui.theme.Amber
import app.switchboard.mobile.ui.theme.Green
import app.switchboard.mobile.ui.theme.Red
import app.switchboard.mobile.ui.theme.SurfaceRaised
import app.switchboard.mobile.ui.theme.TextDim
import app.switchboard.mobile.ui.theme.TextPrimary

/** The chat Details sheet's inputs; a thread gets none when the backend lacks `details_sheet_v1`. */
class ThreadDetails(
    val state: ChatDetailsState,
    /** The Reviews list, for the linked PR's title and checks; null before it is read. */
    val prList: PrListData?,
    val onOpen: (instanceId: String) -> Unit,
    val onClose: () -> Unit,
)

/** Every text colour of the sheet reads at 4.5:1 or better on [DETAILS_SURFACE] (`ChatDetailsTest`). */
internal val DETAILS_SURFACE = SurfaceRaised
internal val LEFT_COLOUR = mapOf(LeftTone.Neutral to TextDim, LeftTone.Warning to Amber, LeftTone.Error to Red)

/**
 * Machine, branch, linked pull request and working-tree changes, then the
 * account's weekly and 5-hour limits beside the chat's context use. Same rows
 * as the desktop's Details popover and the iOS ChatDetailsSheet.tsx.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ChatDetailsSheet(
    machine: String,
    state: ChatDetailsState,
    links: List<PrLink>,
    prList: PrListData?,
    contextUsed: Double?,
    onDismiss: () -> Unit,
) {
    val pr = ChatDetails.pr(links, prList)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = DETAILS_SURFACE,
        modifier = Modifier.testTag(ThreadTestTags.DETAILS_SHEET),
    ) {
        Column(Modifier.fillMaxWidth().padding(bottom = 24.dp)) {
            Text(
                "Details",
                style = MaterialTheme.typography.titleMedium,
                color = TextPrimary,
                modifier = Modifier
                    .padding(start = 24.dp, end = 24.dp, bottom = 12.dp)
                    .semantics { heading() },
            )
            DetailsRow("Machine") { Value(DetailsValue(machine)) }
            DetailsRow("Branch") { Value(ChatDetails.branch(state.branch)) }
            DetailsRow("PR") {
                if (pr == null) {
                    Value(DetailsValue("None", muted = true))
                } else {
                    Text(pr.title, color = TextPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(
                        buildAnnotatedString {
                            pr.detail.forEachIndexed { i, part ->
                                if (i > 0) append(" · ")
                                if (part.bad) withStyle(SpanStyle(color = Red)) { append(part.text) } else append(part.text)
                            }
                        },
                        color = TextDim,
                        style = MaterialTheme.typography.bodySmall,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            DetailsRow("Changes") {
                when (val changes = ChatDetails.changes(state.diff)) {
                    is ChangesValue.Text -> Value(changes.value)
                    is ChangesValue.Lines -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("+${changes.added}", color = Green)
                        Text("-${changes.removed}", color = Red)
                    }
                }
            }
            HorizontalDivider(Modifier.padding(horizontal = 24.dp, vertical = 8.dp))
            ChatDetails.usageBars(state.usage, state.usageReading, contextUsed).forEach { Bar(it) }
        }
    }
}

@Composable
private fun DetailsRow(label: String, content: @Composable () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 24.dp, vertical = 8.dp)
            .semantics(mergeDescendants = true) {},
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(label, color = TextDim, style = MaterialTheme.typography.bodySmall, modifier = Modifier.width(72.dp))
        Column(Modifier.weight(1f)) { content() }
    }
}

@Composable
private fun Value(value: DetailsValue) {
    Text(
        value.text,
        color = if (value.muted) TextDim else TextPrimary,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}

@Composable
private fun Bar(bar: UsageBar) {
    val colour = LEFT_COLOUR.getValue(bar.tone)
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 24.dp, vertical = 8.dp)
            .semantics(mergeDescendants = true) { contentDescription = ChatDetails.barDescription(bar) },
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(bar.label, color = TextPrimary)
            when {
                bar.left != null -> Text("${bar.left}% left", color = colour)
                else -> Text(if (bar.pending) "…" else "Unavailable", color = TextDim)
            }
        }
        Box(
            Modifier
                .padding(top = 6.dp)
                .fillMaxWidth()
                .height(4.dp)
                .clip(RoundedCornerShape(2.dp))
                .background(Color.White.copy(alpha = 0.05f)),
        ) {
            bar.used?.let { used ->
                Box(
                    Modifier
                        .fillMaxWidth(used / 100f)
                        .fillMaxHeight()
                        .background(colour),
                )
            }
        }
    }
}
