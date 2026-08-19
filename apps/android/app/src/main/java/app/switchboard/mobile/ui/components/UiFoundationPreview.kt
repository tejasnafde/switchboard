package app.switchboard.mobile.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import app.switchboard.mobile.ui.theme.SwitchboardTheme

@Preview(showBackground = true, backgroundColor = 0xFF0A0A0A)
@Composable
private fun UiFoundationPreview() {
    SwitchboardTheme {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            SectionLabel("Available now")
            SwitchboardListRow(
                title = "Tejas's MacBook",
                supportingText = "100.99.40.43 · direct",
                leadingContent = {
                    StatusIndicator(StatusTone.SUCCESS)
                },
            )
            InlineStatus(
                message = "Downloading Switchboard 0.5.5",
                detail = "Verifying the signed update",
                tone = StatusTone.INFO,
                progress = InlineStatusProgress.Determinate(0.62f),
                actionLabel = "Cancel",
                onAction = {},
            )
            SwitchboardEmptyState(
                title = "Nothing paired yet",
                body = "Scan the code shown by Switchboard on your Mac.",
                actionLabel = "Pair a machine",
                onAction = {},
            )
        }
    }
}
