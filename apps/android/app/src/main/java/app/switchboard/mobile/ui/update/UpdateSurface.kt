package app.switchboard.mobile.ui.update

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.TextButton
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
import app.switchboard.mobile.update.UpdateState

@Composable
fun UpdateSurface(
    state: UpdateState,
    onAction: (UpdateAction) -> Unit,
    modifier: Modifier = Modifier,
) {
    val presentation = UpdateSurfacePresentation.from(state) ?: return

    Card(
        modifier = modifier
            .fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant,
        ),
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 40.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(
                    modifier = Modifier.weight(1f),
                ) {
                    Text(
                        text = presentation.message,
                        style = MaterialTheme.typography.labelLarge,
                    )
                    if (presentation.placement == UpdateSurfacePlacement.ReservedBanner) {
                        Text(
                            text = presentation.detail,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            style = MaterialTheme.typography.labelSmall,
                        )
                    }
                }

                if (presentation.busy && presentation.progressFraction == null) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(20.dp),
                        strokeWidth = 2.dp,
                    )
                }

                presentation.action?.let { action ->
                    TextButton(onClick = { onAction(action) }) {
                        Text(presentation.actionLabel.orEmpty())
                    }
                }
            }

            if (presentation.placement == UpdateSurfacePlacement.ReservedBanner &&
                state is UpdateState.Downloading
            ) {
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
