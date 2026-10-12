package app.switchboard.mobile.ui.thread

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.switchboard.mobile.domain.thread.SubagentStatus
import app.switchboard.mobile.ui.theme.Accent
import app.switchboard.mobile.ui.theme.Green
import app.switchboard.mobile.ui.theme.Red
import app.switchboard.mobile.ui.theme.SurfaceRaised
import app.switchboard.mobile.ui.theme.TextDim
import app.switchboard.mobile.ui.theme.TextFaint

/**
 * One Agent/Task call: collapsed it is the description, the model and the
 * status line; a tap opens the subagent's steps, the folds and the report.
 */
@Composable
internal fun SubagentRow(row: ThreadRowPresentation.Subagent) {
    var expanded by rememberSaveable(row.key) { mutableStateOf(false) }
    val expandable = row.items.isNotEmpty() || row.result != null
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 2.dp),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = ToolActivityLayoutPolicy.CollapsedRowHeightDp.dp)
                .clip(RoundedCornerShape(6.dp))
                .then(
                    if (expandable) {
                        Modifier.clickable(
                            role = Role.Button,
                            onClickLabel = if (expanded) "Hide steps" else "Show steps",
                        ) { expanded = !expanded }
                    } else {
                        Modifier
                    },
                )
                .semantics(mergeDescendants = true) {
                    contentDescription = listOfNotNull("Agent", row.description, row.model, row.statusText)
                        .joinToString(", ")
                    if (expandable) stateDescription = if (expanded) "Expanded" else "Collapsed"
                }
                .testTag(ThreadTestTags.subagentRow(row.key))
                .padding(vertical = 6.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.width(24.dp), contentAlignment = Alignment.CenterStart) {
                    Text(text = "✦", color = TextDim, fontSize = 13.sp, maxLines = 1)
                }
                Text(
                    text = "Agent",
                    fontWeight = FontWeight.SemiBold,
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 1,
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    text = row.description,
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                row.model?.let { model ->
                    Spacer(Modifier.width(8.dp))
                    Text(text = model, color = TextFaint, style = MaterialTheme.typography.bodySmall, maxLines = 1)
                }
                Spacer(Modifier.weight(1f))
                if (expandable) {
                    Text(text = if (expanded) "⌃" else "⌄", color = TextDim, fontSize = 14.sp)
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .width(24.dp)
                        .testTag(ThreadTestTags.subagentStatus(row.key))
                        // Tag first: clearAndSetSemantics drops every semantics modifier after it.
                        .clearAndSetSemantics { },
                    contentAlignment = Alignment.CenterStart,
                ) {
                    when (row.status) {
                        SubagentStatus.RUNNING ->
                            CircularProgressIndicator(color = Accent, modifier = Modifier.size(12.dp), strokeWidth = 2.dp)
                        SubagentStatus.DONE -> Text(text = "✓", color = Green, fontSize = 12.sp)
                        SubagentStatus.FAILED -> Text(text = "✕", color = Red, fontSize = 12.sp)
                    }
                }
                Text(
                    text = row.statusText,
                    color = TextDim,
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.testTag(ThreadTestTags.subagentStatusText(row.key)),
                )
            }
        }
        if (expanded && expandable) {
            SubagentSteps(row)
        }
    }
}

@Composable
private fun SubagentSteps(row: ThreadRowPresentation.Subagent) {
    // A guide line on the left ties the steps to their agent. Drawn, not
    // measured: a tool row's output list cannot answer intrinsic sizes.
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .drawBehind {
                val x = 7.dp.toPx()
                drawLine(SurfaceRaised, Offset(x, 0f), Offset(x, size.height), strokeWidth = 1.dp.toPx())
            }
            .padding(start = 20.dp)
            .testTag(ThreadTestTags.subagentSteps(row.key)),
    ) {
        row.items.forEach { item ->
            when (item) {
                is SubagentItemRow.Step -> SubagentStepRow(item.row, failed = item.failed)
                is SubagentItemRow.Fold -> SubagentFold(item)
            }
        }
        row.result?.let { result ->
            SelectionContainer {
                Text(
                    text = result,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier
                        .padding(vertical = 8.dp)
                        .testTag(ThreadTestTags.subagentResult(row.key)),
                )
            }
        }
    }
}

@Composable
private fun SubagentFold(fold: SubagentItemRow.Fold) {
    var open by rememberSaveable(fold.key) { mutableStateOf(false) }
    Text(
        text = fold.label,
        color = TextDim,
        style = MaterialTheme.typography.bodySmall,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 40.dp)
            .clickable(role = Role.Button, onClickLabel = if (open) "Hide" else "Show") { open = !open }
            .semantics { stateDescription = if (open) "Expanded" else "Collapsed" }
            .testTag(ThreadTestTags.subagentFold(fold.key))
            .padding(vertical = 11.dp),
    )
    if (open) fold.rows.forEach { SubagentStepRow(it, failed = false) }
}

@Composable
private fun SubagentStepRow(row: ThreadRowPresentation, failed: Boolean) {
    when (row) {
        is ThreadRowPresentation.Tool -> ToolRow(row, quiet = true, initiallyExpanded = failed)
        is ThreadRowPresentation.Synthetic -> SyntheticRow(row)
        is ThreadRowPresentation.Text -> Text(
            text = row.source.text,
            color = TextDim,
            style = MaterialTheme.typography.bodySmall,
            maxLines = 4,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(vertical = 6.dp),
        )
        // Steps are only tool, notice and text rows.
        else -> Unit
    }
}
