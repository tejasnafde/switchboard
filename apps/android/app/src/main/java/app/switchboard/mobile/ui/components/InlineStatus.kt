package app.switchboard.mobile.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.switchboard.mobile.ui.theme.SwitchboardDimensions

@Composable
fun InlineStatus(
    message: String,
    modifier: Modifier = Modifier,
    detail: String? = null,
    detailMaxLines: Int = 1,
    tone: StatusTone = StatusTone.NEUTRAL,
    progress: InlineStatusProgress = InlineStatusProgress.None,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
) {
    Surface(
        modifier = modifier
            .fillMaxWidth()
            .semantics { liveRegion = LiveRegionMode.Polite },
        shape = MaterialTheme.shapes.small,
        color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        tonalElevation = 0.dp,
    ) {
        Column(
            modifier = Modifier.padding(start = 14.dp, end = 6.dp, top = 8.dp, bottom = 8.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                when (progress) {
                    InlineStatusProgress.None -> StatusIndicator(
                        tone = tone,
                    )
                    InlineStatusProgress.Indeterminate -> CircularProgressIndicator(
                        modifier = Modifier.size(16.dp),
                        color = tone.indicatorColor,
                        strokeWidth = 2.dp,
                    )
                    is InlineStatusProgress.Determinate -> StatusIndicator(
                        tone = tone,
                    )
                }
                Spacer(Modifier.width(10.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = message,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.titleSmall,
                    )
                    detail?.let {
                        Text(
                            text = it,
                            maxLines = detailMaxLines,
                            overflow = TextOverflow.Ellipsis,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            style = MaterialTheme.typography.labelSmall,
                        )
                    }
                }
                if (actionLabel != null && onAction != null) {
                    TextButton(
                        onClick = onAction,
                        modifier = Modifier.heightIn(min = SwitchboardDimensions.minimumTouchTarget),
                    ) {
                        Text(actionLabel)
                    }
                }
            }
            if (progress is InlineStatusProgress.Determinate) {
                LinearProgressIndicator(
                    progress = { progress.boundedValue },
                    modifier = Modifier.fillMaxWidth(),
                    color = tone.indicatorColor,
                    trackColor = MaterialTheme.colorScheme.surfaceVariant,
                )
            }
        }
    }
}
