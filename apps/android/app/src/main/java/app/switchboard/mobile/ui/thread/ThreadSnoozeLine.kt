package app.switchboard.mobile.ui.thread

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.switchboard.mobile.domain.remote.ChatSnooze
import app.switchboard.mobile.ui.theme.Surface
import app.switchboard.mobile.ui.theme.TextPrimary

/**
 * The line of a snoozed chat open on the phone: "Snoozed until 20:00" with
 * Wake now. The chat stays open after a snooze from elsewhere; its Home row
 * waits in the Snoozed shelf. [onWake] calls back with the line to show when
 * the wake did not happen, or null.
 */
@Composable
fun ThreadSnoozeLine(state: ChatSnooze.State, onWake: (onDone: (String?) -> Unit) -> Unit) {
    var busy by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf<String?>(null) }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(Surface)
            .padding(horizontal = 16.dp, vertical = 8.dp)
            .testTag(ThreadTestTags.SNOOZE_LINE),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = ChatSnooze.snoozeLineText(state.snoozedUntil, state.snoozePr, System.currentTimeMillis()),
                color = TextPrimary,
                style = MaterialTheme.typography.labelLarge,
                modifier = Modifier
                    .weight(1f)
                    .semantics { liveRegion = LiveRegionMode.Polite },
            )
            OutlinedButton(
                onClick = {
                    busy = true
                    note = null
                    onWake { refused ->
                        busy = false
                        note = refused
                    }
                },
                enabled = !busy,
                modifier = Modifier
                    .heightIn(min = 48.dp)
                    .testTag(ThreadTestTags.SNOOZE_WAKE),
            ) { Text("Wake now") }
        }
        note?.let {
            Text(text = it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelSmall)
        }
    }
}
