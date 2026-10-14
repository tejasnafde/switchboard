package app.switchboard.mobile.ui.demo

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.switchboard.mobile.ui.theme.Background
import app.switchboard.mobile.ui.theme.TextDim
import app.switchboard.mobile.ui.theme.Violet
import app.switchboard.mobile.ui.theme.VioletTint

/** True on every screen while the demo runs; screens hide what the demo cannot do. */
val LocalPhoneDemo = staticCompositionLocalOf { false }

object PhoneDemoCopy {
    const val TRY = "Try the demo"
    const val TRY_DETAIL = "Sample chats and pull requests on this phone. No machine needed, nothing is sent anywhere."
    const val STRIP_TITLE = "Demo"
    const val STRIP_DETAIL = "sample data, offline"
    const val LEAVE = "Leave demo"
    const val LEAVE_TITLE = "Leave the demo?"
    const val LEAVE_BODY = "You go back to the empty Connections screen. Nothing from the demo is kept, and you can open it again any time."
    const val STAY = "Stay"
    const val BADGE = "DEMO"
    const val NOT_IN_DEMO = "Not in the demo"
}

object PhoneDemoTestTags {
    const val TRY = "phone-demo-try"
    const val STRIP = "phone-demo-strip"
    const val LEAVE = "phone-demo-leave"
    const val CONFIRM_LEAVE = "phone-demo-confirm-leave"
    const val BADGE = "phone-demo-badge"
}

/** External links open nothing in the demo: its pull requests and URLs are made up. */
object DemoUriHandler : UriHandler {
    override fun openUri(uri: String) = Unit
}

/** The secondary "Try the demo" button and its promise, under the pairing buttons. */
@Composable
fun TryDemoButton(onClick: () -> Unit, modifier: Modifier = Modifier) {
    Column(modifier = modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        OutlinedButton(
            onClick = onClick,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                .testTag(PhoneDemoTestTags.TRY),
        ) {
            Icon(Icons.Filled.PlayArrow, contentDescription = null, tint = Violet)
            Text(PhoneDemoCopy.TRY, modifier = Modifier.padding(start = 6.dp))
        }
        Text(
            text = PhoneDemoCopy.TRY_DETAIL,
            color = TextDim,
            style = MaterialTheme.typography.bodySmall,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 8.dp, start = 8.dp, end = 8.dp),
        )
    }
}

/** The strip at the top of every demo screen. It takes the status bar inset. */
@Composable
fun DemoStrip(onLeave: () -> Unit, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(Background)
            .statusBarsPadding()
            .padding(horizontal = 12.dp, vertical = 6.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(VioletTint)
            .border(BorderStroke(1.dp, Violet.copy(alpha = 0.35f)), RoundedCornerShape(10.dp))
            .testTag(PhoneDemoTestTags.STRIP)
            .padding(start = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = PhoneDemoCopy.STRIP_TITLE,
            color = Violet,
            fontWeight = FontWeight.SemiBold,
            style = MaterialTheme.typography.labelLarge,
        )
        Text(
            text = " · ${PhoneDemoCopy.STRIP_DETAIL}",
            color = TextDim,
            style = MaterialTheme.typography.labelLarge,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        TextButton(
            onClick = onLeave,
            modifier = Modifier
                .heightIn(min = 48.dp)
                .testTag(PhoneDemoTestTags.LEAVE),
        ) {
            Text(PhoneDemoCopy.LEAVE, color = Violet, fontWeight = FontWeight.SemiBold)
        }
    }
}

/** The DEMO badge next to the demo machine's name. Nothing outside the demo. */
@Composable
fun DemoBadge(modifier: Modifier = Modifier) {
    if (!LocalPhoneDemo.current) return
    Text(
        text = PhoneDemoCopy.BADGE,
        color = Violet,
        fontWeight = FontWeight.Bold,
        fontSize = 10.sp,
        letterSpacing = 0.8.sp,
        modifier = modifier
            .clip(RoundedCornerShape(4.dp))
            .background(VioletTint)
            .border(BorderStroke(1.dp, Violet.copy(alpha = 0.45f)), RoundedCornerShape(4.dp))
            .padding(horizontal = 5.dp, vertical = 1.dp)
            .testTag(PhoneDemoTestTags.BADGE),
    )
}

@Composable
fun LeaveDemoDialog(onLeave: () -> Unit, onStay: () -> Unit) {
    AlertDialog(
        onDismissRequest = onStay,
        title = { Text(PhoneDemoCopy.LEAVE_TITLE, modifier = Modifier.semantics { heading() }) },
        text = { Text(PhoneDemoCopy.LEAVE_BODY, color = TextDim) },
        confirmButton = {
            Button(
                onClick = onLeave,
                colors = ButtonDefaults.buttonColors(containerColor = Violet, contentColor = Background),
                modifier = Modifier.testTag(PhoneDemoTestTags.CONFIRM_LEAVE),
            ) {
                Text(PhoneDemoCopy.LEAVE, fontWeight = FontWeight.SemiBold)
            }
        },
        dismissButton = {
            TextButton(onClick = onStay) { Text(PhoneDemoCopy.STAY) }
        },
    )
}
