package app.switchboard.mobile.ui.connections

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.switchboard.mobile.ui.theme.Accent
import app.switchboard.mobile.ui.theme.Amber
import app.switchboard.mobile.ui.theme.GeistMono
import app.switchboard.mobile.ui.theme.Green
import app.switchboard.mobile.ui.theme.Red
import app.switchboard.mobile.ui.theme.Surface
import app.switchboard.mobile.ui.theme.SurfaceRaised
import app.switchboard.mobile.ui.theme.TextDim
import app.switchboard.mobile.ui.theme.TextPrimary
import app.switchboard.mobile.platform.google.GoogleAccountPresentation

@OptIn(ExperimentalFoundationApi::class, ExperimentalMaterial3Api::class)
@Composable
fun ConnectionsScreen(
    presentation: ConnectionsPresentation,
    buildStamp: String,
    onAdd: () -> Unit,
    onManualAdd: () -> Unit,
    onEdit: (String) -> Unit,
    onConnectionIntent: (ConnectionIntent) -> Unit,
    googleAccount: GoogleAccountPresentation = GoogleAccountPresentation.SignedOut,
    onGoogleAccount: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    var actionRow by remember { mutableStateOf<ConnectionRowPresentation?>(null) }
    var removeRow by remember { mutableStateOf<ConnectionRowPresentation?>(null) }

    Column(
        modifier = modifier
            .fillMaxSize()
            .semantics { isTraversalGroup = true },
    ) {
        ConnectionsTopBar(
            googleAccount = googleAccount,
            onGoogleAccount = onGoogleAccount,
            onAdd = onAdd,
        )
        when (presentation) {
            ConnectionsPresentation.Loading -> LoadingState()
            ConnectionsPresentation.Empty -> EmptyState(
                buildStamp = buildStamp,
                onScan = onAdd,
                onManualAdd = onManualAdd,
            )

            is ConnectionsPresentation.Failure -> FailureState(
                message = presentation.message,
                onRetry = { onConnectionIntent(ConnectionIntent.Retry) },
            )

            is ConnectionsPresentation.Content -> ConnectionsList(
                presentation = presentation,
                buildStamp = buildStamp,
                onOpen = { onConnectionIntent(ConnectionIntent.Open(it)) },
                onLongPress = { actionRow = it },
            )
        }
    }

    actionRow?.let { row ->
        ModalBottomSheet(onDismissRequest = { actionRow = null }) {
            Text(
                text = row.label,
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(horizontal = 24.dp),
            )
            Text(
                text = row.target,
                color = TextDim,
                fontFamily = GeistMono,
                fontSize = 12.sp,
                modifier = Modifier.padding(horizontal = 24.dp, vertical = 4.dp),
            )
            Spacer(Modifier.height(12.dp))
            ConnectionsPresenter.actions(row.status).forEach { action ->
                TextButton(
                    onClick = {
                        actionRow = null
                        when (action.kind) {
                            ConnectionActionKind.EDIT -> onEdit(row.id)
                            ConnectionActionKind.CONNECT -> {
                                onConnectionIntent(ConnectionIntent.Connect(row.id))
                            }

                            ConnectionActionKind.DISCONNECT -> {
                                onConnectionIntent(ConnectionIntent.Disconnect(row.id))
                            }

                            ConnectionActionKind.REMOVE -> removeRow = row
                            ConnectionActionKind.CANCEL -> Unit
                        }
                    },
                    colors = ButtonDefaults.textButtonColors(
                        contentColor = if (action.style == ConnectionActionStyle.DESTRUCTIVE) {
                            Red
                        } else {
                            TextPrimary
                        },
                    ),
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp),
                ) {
                    Text(action.label)
                }
            }
            Spacer(Modifier.navigationBarsPadding())
        }
    }

    removeRow?.let { row ->
        AlertDialog(
            onDismissRequest = { removeRow = null },
            title = { Text("Remove machine?") },
            text = { Text("\"${row.label}\" will be forgotten on this device.") },
            dismissButton = {
                TextButton(onClick = { removeRow = null }) { Text("Cancel") }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        removeRow = null
                        onConnectionIntent(ConnectionIntent.Remove(row.id))
                    },
                    colors = ButtonDefaults.textButtonColors(contentColor = Red),
                ) {
                    Text("Remove")
                }
            },
        )
    }
}

@Composable
private fun ConnectionsTopBar(
    googleAccount: GoogleAccountPresentation,
    onGoogleAccount: () -> Unit,
    onAdd: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .statusBarsPadding()
            .heightIn(min = 56.dp)
            .padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TextButton(
            onClick = onGoogleAccount,
            modifier = Modifier
                .size(48.dp)
                .semantics {
                    contentDescription = "Google account"
                    stateDescription = when (googleAccount) {
                        GoogleAccountPresentation.SignedOut -> "Signed out"
                        is GoogleAccountPresentation.SignedIn -> "Signed in"
                        GoogleAccountPresentation.Blocked -> "Blocked"
                    }
                },
        ) {
            Text(
                text = GoogleAccountAvatarPolicy.monogram(googleAccount),
                fontFamily = GeistMono,
                fontWeight = FontWeight.Medium,
            )
        }
        Spacer(Modifier.width(8.dp))
        Text(
            text = "Switchboard",
            style = MaterialTheme.typography.titleMedium,
            modifier = Modifier
                .weight(1f)
                .semantics { heading() },
        )
        TextButton(
            onClick = onAdd,
            modifier = Modifier
                .size(48.dp)
                .semantics { contentDescription = "Add machine" },
        ) {
            Text(
                text = "+",
                fontSize = 28.sp,
                fontWeight = FontWeight.Normal,
            )
        }
    }
}

@Composable
private fun LoadingState() {
    Column(
        modifier = Modifier.fillMaxSize(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        CircularProgressIndicator(modifier = Modifier.size(28.dp), strokeWidth = 2.dp)
        Text(
            text = "Loading machines",
            color = TextDim,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.padding(top = 16.dp),
        )
    }
}

@Composable
private fun EmptyState(
    buildStamp: String,
    onScan: () -> Unit,
    onManualAdd: () -> Unit,
) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(
            start = 24.dp,
            top = 56.dp,
            end = 24.dp,
            bottom = 132.dp,
        ),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        item {
            Text("Nothing paired yet", style = MaterialTheme.typography.headlineLarge)
            Text(
                text = "Start Switchboard on a machine, then scan the QR it prints. Everything it can reach shows up here.",
                color = TextDim,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(top = 12.dp, bottom = 24.dp),
            )
            EmptyCode("npm run dev", "desktop app, shares its sessions")
            EmptyCode("npm run server", "headless, its own session pool")
            Button(
                onClick = onScan,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 16.dp)
                    .heightIn(min = 48.dp),
            ) {
                Text("Scan a pairing QR")
            }
            OutlinedButton(
                onClick = onManualAdd,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 8.dp)
                    .heightIn(min = 48.dp),
            ) {
                Text("Enter address manually")
            }
            BuildStamp(buildStamp, Modifier.padding(top = 32.dp))
        }
    }
}

@Composable
private fun EmptyCode(command: String, note: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(bottom = 8.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(Surface)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = command,
            color = Accent,
            fontFamily = GeistMono,
            fontSize = 13.sp,
            modifier = Modifier.weight(1f),
        )
        Text(text = note, color = TextDim, fontSize = 11.sp)
    }
}

@Composable
private fun FailureState(message: String, onRetry: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text("Could not load machines", style = MaterialTheme.typography.titleMedium)
        Text(
            text = message,
            color = TextDim,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.padding(top = 8.dp, bottom = 20.dp),
        )
        OutlinedButton(onClick = onRetry, modifier = Modifier.heightIn(min = 48.dp)) {
            Text("Try again")
        }
    }
}

@Composable
private fun ConnectionsList(
    presentation: ConnectionsPresentation.Content,
    buildStamp: String,
    onOpen: (String) -> Unit,
    onLongPress: (ConnectionRowPresentation) -> Unit,
) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(
            start = 20.dp,
            end = 20.dp,
            bottom = 132.dp,
        ),
    ) {
        item {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 16.dp, bottom = 12.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "MACHINES",
                    color = TextDim,
                    fontFamily = GeistMono,
                    fontSize = 11.sp,
                )
                Text(
                    text = presentation.summary,
                    color = TextDim,
                    fontFamily = GeistMono,
                    fontSize = 11.sp,
                )
            }
        }
        presentation.recoveryMessage?.let { message ->
            item {
                Text(
                    text = message,
                    color = Amber,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(bottom = 12.dp)
                        .clip(RoundedCornerShape(10.dp))
                        .background(SurfaceRaised)
                        .semantics { liveRegion = LiveRegionMode.Polite }
                        .padding(12.dp),
                )
            }
        }
        items(presentation.rows, key = { it.id }) { row ->
            ConnectionRow(
                row = row,
                onOpen = { onOpen(row.id) },
                onLongPress = { onLongPress(row) },
            )
        }
        item { BuildStamp(buildStamp, Modifier.padding(top = 16.dp)) }
    }
}

@Composable
private fun ConnectionRow(
    row: ConnectionRowPresentation,
    onOpen: () -> Unit,
    onLongPress: () -> Unit,
) {
    val interactionSource = remember { MutableInteractionSource() }
    val pressed by interactionSource.collectIsPressedAsState()
    val indication = LocalIndication.current
    val tint = when (row.status) {
        ConnectionStatus.LIVE -> Green
        ConnectionStatus.CONNECTING -> Amber
        ConnectionStatus.OFFLINE -> TextDim
        ConnectionStatus.ERROR -> Red
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(bottom = 12.dp)
            .heightIn(min = 78.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(if (pressed) SurfaceRaised else Surface)
            .semantics(mergeDescendants = true) {
                contentDescription = ConnectionsAccessibilityPolicy.contentDescription(row)
                stateDescription = ConnectionsAccessibilityPolicy.stateDescription(row)
            }
            .combinedClickable(
                interactionSource = interactionSource,
                indication = indication,
                role = Role.Button,
                onClickLabel = "Open ${row.label}",
                onLongClickLabel = ConnectionsAccessibilityPolicy.longClickLabel(row),
                onClick = onOpen,
                onLongClick = onLongPress,
            ),
    ) {
        Box(
            modifier = Modifier
                .width(3.dp)
                .heightIn(min = 78.dp)
                .background(tint),
        )
        Column(
            modifier = Modifier
                .weight(1f)
                .padding(horizontal = 16.dp, vertical = 12.dp)
                .clearAndSetSemantics {},
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = row.label,
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (row.kind == ConnectionKind.IAP) {
                    Text(
                        text = "IAP",
                        color = Accent,
                        fontFamily = GeistMono,
                        fontSize = 10.sp,
                        modifier = Modifier
                            .padding(start = 8.dp)
                            .clip(RoundedCornerShape(5.dp))
                            .background(Accent.copy(alpha = 0.12f))
                            .padding(horizontal = 6.dp, vertical = 2.dp),
                    )
                }
            }
            Text(
                text = row.target,
                color = TextDim,
                fontFamily = GeistMono,
                fontSize = 12.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 2.dp),
            )
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(top = 6.dp),
            ) {
                Box(
                    modifier = Modifier
                        .size(10.dp)
                        .clearAndSetSemantics {},
                    contentAlignment = Alignment.Center,
                ) {
                    if (row.showProgress) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(10.dp),
                            strokeWidth = 1.5.dp,
                            color = tint,
                        )
                    } else {
                        Box(
                            modifier = Modifier
                                .size(7.dp)
                                .clip(CircleShape)
                                .background(tint),
                        )
                    }
                }
                Text(
                    text = row.statusLabel,
                    color = TextDim,
                    fontFamily = GeistMono,
                    fontSize = 11.sp,
                    modifier = Modifier.padding(start = 8.dp),
                )
                row.detail?.let { detail ->
                    Text(
                        text = detail,
                        color = TextDim,
                        fontFamily = GeistMono,
                        fontSize = 11.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(start = 8.dp),
                    )
                }
            }
        }
    }
}

object ConnectionsAccessibilityPolicy {
    fun contentDescription(row: ConnectionRowPresentation): String =
        "${row.label}, ${row.target}"

    fun stateDescription(row: ConnectionRowPresentation): String =
        listOfNotNull(row.statusLabel, row.detail?.takeIf(String::isNotBlank)).joinToString(", ")

    fun longClickLabel(row: ConnectionRowPresentation): String = "Show actions for ${row.label}"
}

@Composable
private fun BuildStamp(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text,
        color = TextDim.copy(alpha = 0.72f),
        fontFamily = GeistMono,
        fontSize = 10.sp,
        modifier = modifier
            .fillMaxWidth()
            .padding(vertical = 12.dp),
    )
}
