package app.switchboard.mobile.ui.update

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.switchboard.mobile.update.UpdateAction
import app.switchboard.mobile.update.UpdatePresentation
import app.switchboard.mobile.update.UpdateState

@Composable
fun UpdateSurface(
    state: UpdateState,
    onAction: (UpdateAction) -> Unit,
    modifier: Modifier = Modifier,
) {
    val presentation = UpdatePresentation.from(state)
    if (!presentation.visible) return

    Card(
        modifier = modifier
            .fillMaxWidth()
            .widthIn(max = 560.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant,
        ),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Text(
                        text = presentation.title,
                        style = MaterialTheme.typography.titleMedium,
                    )
                    Text(
                        text = presentation.detail,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }

                if (presentation.busy && state !is UpdateState.Downloading) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(20.dp),
                        strokeWidth = 2.dp,
                    )
                }

                presentation.primaryAction?.let { action ->
                    Button(onClick = { onAction(action) }) {
                        Text(action.label)
                    }
                }
            }

            if (state is UpdateState.Downloading) {
                val fraction = presentation.progressFraction
                if (fraction == null) {
                    LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                } else {
                    LinearProgressIndicator(
                        progress = { fraction },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }
    }
}

private val UpdateAction.label: String
    get() = when (this) {
        UpdateAction.CHECK -> "Check again"
        UpdateAction.DOWNLOAD -> "Download"
        UpdateAction.CANCEL -> "Cancel"
        UpdateAction.INSTALL -> "Install"
        UpdateAction.OPEN_SETTINGS -> "Open settings"
        UpdateAction.RETRY -> "Retry"
    }
