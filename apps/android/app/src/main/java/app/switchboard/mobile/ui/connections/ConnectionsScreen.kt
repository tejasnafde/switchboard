package app.switchboard.mobile.ui.connections

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.FilledTonalButton
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import app.switchboard.mobile.domain.connection.ConnectionSecurity
import app.switchboard.mobile.domain.connection.ConnectionSecurityCopy
import app.switchboard.mobile.domain.connection.ConnectionSecurityPolicy
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.isTraversalGroup
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
import app.switchboard.mobile.ui.components.InlineStatus
import app.switchboard.mobile.ui.components.SectionLabel
import app.switchboard.mobile.ui.components.StatusTone
import app.switchboard.mobile.ui.demo.TryDemoButton

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
    onBack: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
    onTryDemo: (() -> Unit)? = null,
    onRescan: (String) -> Unit = {},
    onUseIap: () -> Unit = {},
) {
    var actionRow by remember { mutableStateOf<ConnectionRowPresentation?>(null) }
    var removeRow by remember { mutableStateOf<ConnectionRowPresentation?>(null) }
    var certificateRow by remember { mutableStateOf<ConnectionRowPresentation?>(null) }

    Column(
        modifier = modifier
            .fillMaxSize()
            .semantics { isTraversalGroup = true },
    ) {
        ConnectionsTopBar(
            googleAccount = googleAccount,
            onGoogleAccount = onGoogleAccount,
            onAdd = onAdd,
            onBack = onBack,
        )
        when (presentation) {
            ConnectionsPresentation.Loading -> LoadingState()
            ConnectionsPresentation.Empty -> EmptyState(
                buildStamp = buildStamp,
                onScan = onAdd,
                onManualAdd = onManualAdd,
                onTryDemo = onTryDemo,
            )

            is ConnectionsPresentation.Failure -> FailureState(
                message = presentation.message,
                onRetry = { onConnectionIntent(ConnectionIntent.Retry) },
            )

            is ConnectionsPresentation.Content -> ConnectionsList(
                presentation = presentation,
                buildStamp = buildStamp,
                onOpen = { row ->
                    if (row.security == ConnectionSecurity.CERTIFICATE_CHANGED) {
                        certificateRow = row
                    } else {
                        onConnectionIntent(ConnectionIntent.Open(row.id))
                    }
                },
                onLongPress = { actionRow = it },
                onRescan = onRescan,
                onUseIap = onUseIap,
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
        }
    }

    certificateRow?.let { row ->
        CertificateChangedSheet(
            row = row,
            onScan = {
                certificateRow = null
                onRescan(row.id)
            },
            onRemove = {
                certificateRow = null
                removeRow = row
            },
            onDismiss = { certificateRow = null },
        )
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
    onBack: (() -> Unit)?,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .statusBarsPadding()
            .heightIn(min = 56.dp)
            .padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (onBack != null) {
            IconButton(onClick = onBack, modifier = Modifier.size(48.dp)) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
            }
        } else {
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
                GoogleAccountAvatarPolicy.monogramOrNull(googleAccount)?.let { monogram ->
                    Text(
                        text = monogram,
                        fontFamily = GeistMono,
                        fontWeight = FontWeight.Medium,
                    )
                } ?: Icon(
                    imageVector = Icons.Filled.AccountCircle,
                    contentDescription = null,
                )
            }
        }
        Spacer(Modifier.width(8.dp))
        Text(
            text = "Machines",
            style = MaterialTheme.typography.titleLarge,
            modifier = Modifier
                .weight(1f)
                .semantics { heading() },
        )
        IconButton(
            onClick = onAdd,
            modifier = Modifier
                .size(48.dp)
                .semantics { contentDescription = "Add machine" },
        ) {
            Icon(Icons.Default.Add, contentDescription = null)
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
    onTryDemo: (() -> Unit)?,
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
            onTryDemo?.let { TryDemoButton(onClick = it, modifier = Modifier.padding(top = 8.dp)) }
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
    onOpen: (ConnectionRowPresentation) -> Unit,
    onLongPress: (ConnectionRowPresentation) -> Unit,
    onRescan: (String) -> Unit,
    onUseIap: () -> Unit,
) {
    val sections = ConnectionsListPolicy.sections(presentation.rows)
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(
            start = 20.dp,
            end = 20.dp,
            bottom = 132.dp,
        ),
    ) {
        item { MachineSectionHeader(ConnectionSecurityCopy.SECTION_LIVE, presentation.summary) }
        presentation.recoveryMessage?.let { message ->
            item {
                InlineStatus(
                    message = "Some machines need attention",
                    detail = message,
                    tone = StatusTone.WARNING,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(bottom = 12.dp),
                )
            }
        }
        items(sections.live, key = { it.id }) { row ->
            ConnectionRow(
                row = row,
                onOpen = { onOpen(row) },
                onLongPress = { onLongPress(row) },
            )
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.55f))
        }
        if (sections.attention.isNotEmpty()) {
            item { MachineSectionHeader(ConnectionSecurityCopy.SECTION_ATTENTION) }
        }
        items(sections.attention, key = { it.id }) { row ->
            ConnectionRow(
                row = row,
                onOpen = { onOpen(row) },
                onLongPress = { onLongPress(row) },
            )
            if (row.security == ConnectionSecurity.REFUSED) {
                RefusedHint(onScan = { onRescan(row.id) }, onUseIap = onUseIap)
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.55f))
        }
        item { BuildStamp(buildStamp, Modifier.padding(top = 16.dp)) }
    }
}

@Composable
private fun MachineSectionHeader(label: String, summary: String? = null) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 24.dp, bottom = 10.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        SectionLabel(label)
        summary?.let {
            Text(it, color = TextDim, fontFamily = GeistMono, fontSize = 11.sp)
        }
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
    val tint = when {
        row.security == ConnectionSecurity.REFUSED -> Amber
        row.security == ConnectionSecurity.CERTIFICATE_CHANGED -> Red
        row.status == ConnectionStatus.LIVE -> Green
        row.status == ConnectionStatus.CONNECTING -> Amber
        row.status == ConnectionStatus.OFFLINE -> TextDim
        else -> Red
    }
    val warns = row.security == ConnectionSecurity.REFUSED || row.security == ConnectionSecurity.CERTIFICATE_CHANGED
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 72.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(if (pressed) SurfaceRaised else Color.Transparent)
            .semantics(mergeDescendants = true) {
                contentDescription = ConnectionsAccessibilityPolicy.contentDescription(row)
                stateDescription = ConnectionsAccessibilityPolicy.stateDescription(row)
            }
            .combinedClickable(
                interactionSource = interactionSource,
                indication = indication,
                role = Role.Button,
                onClickLabel = ConnectionsAccessibilityPolicy.clickLabel(row),
                onLongClickLabel = ConnectionsAccessibilityPolicy.longClickLabel(row),
                onClick = onOpen,
                onLongClick = onLongPress,
            )
            .padding(vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(10.dp)
                .clearAndSetSemantics {},
            contentAlignment = Alignment.Center,
        ) {
            if (row.showProgress && !warns) {
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
        Column(
            modifier = Modifier
                .weight(1f)
                .padding(horizontal = 12.dp)
                .clearAndSetSemantics {},
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = row.label,
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                row.shortFingerprint?.let {
                    Text(
                        text = it,
                        color = TextDim,
                        fontFamily = GeistMono,
                        fontSize = 12.sp,
                        modifier = Modifier.padding(start = 10.dp),
                    )
                }
            }
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(top = 3.dp),
            ) {
                val icon = when {
                    warns -> Icons.Default.Warning
                    ConnectionSecurityPolicy.showsLock(row.security) -> Icons.Default.Lock
                    else -> null
                }
                icon?.let {
                    Icon(it, contentDescription = null, tint = TextDim, modifier = Modifier.size(12.dp))
                    Spacer(Modifier.width(6.dp))
                }
                Text(
                    text = ConnectionSecurityPolicy.label(row.security),
                    color = TextDim,
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 1,
                )
                Text(
                    text = " · ${row.address}",
                    color = TextDim,
                    fontFamily = GeistMono,
                    fontSize = 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            ConnectionsListPolicy.statusDetail(row)?.let {
                Text(
                    text = it,
                    color = if (row.status == ConnectionStatus.ERROR) Red else TextDim,
                    fontFamily = GeistMono,
                    fontSize = 11.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(top = 2.dp),
                )
            }
        }
        Icon(
            Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = null,
            tint = TextDim,
            modifier = Modifier.clearAndSetSemantics {},
        )
    }
}

/** The amber hint under a row this build will not dial: the QR first, then Cloud IAP. Never a retry. */
@Composable
private fun RefusedHint(onScan: () -> Unit, onUseIap: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 22.dp, bottom = 12.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(Amber.copy(alpha = 0.08f))
            .border(1.dp, Amber.copy(alpha = 0.35f), RoundedCornerShape(10.dp))
            .padding(12.dp),
    ) {
        Text(
            text = ConnectionSecurityCopy.REFUSED_HINT,
            color = TextPrimary,
            style = MaterialTheme.typography.bodySmall,
        )
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier.padding(top = 10.dp),
        ) {
            Button(onClick = onScan, modifier = Modifier.heightIn(min = 40.dp)) {
                Text(ConnectionSecurityCopy.SCAN_NEW_QR)
            }
            FilledTonalButton(onClick = onUseIap, modifier = Modifier.heightIn(min = 40.dp)) {
                Text(ConnectionSecurityCopy.USE_CLOUD_IAP)
            }
        }
    }
}

/**
 * Opened by a tap on a certificate-changed row, before any scanner, so the
 * interception warning is read first.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CertificateChangedSheet(
    row: ConnectionRowPresentation,
    onScan: () -> Unit,
    onRemove: () -> Unit,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(modifier = Modifier.padding(start = 24.dp, end = 24.dp, bottom = 24.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.Warning, contentDescription = null, tint = Red, modifier = Modifier.size(22.dp))
                Spacer(Modifier.width(10.dp))
                Text(
                    text = ConnectionSecurityCopy.CERTIFICATE_CHANGED,
                    style = MaterialTheme.typography.headlineSmall,
                    modifier = Modifier.semantics { heading() },
                )
            }
            Text(
                text = ConnectionSecurityCopy.fill(ConnectionSecurityCopy.CERTIFICATE_CHANGED_BODY, "label" to row.label),
                color = TextDim,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(top = 8.dp, bottom = 14.dp),
            )
            SheetCard(
                title = ConnectionSecurityCopy.CERTIFICATE_EXPECTED_TITLE,
                body = AnnotatedString(ConnectionSecurityCopy.CERTIFICATE_EXPECTED_BODY),
            )
            SheetCard(
                title = ConnectionSecurityCopy.CERTIFICATE_UNEXPECTED_TITLE,
                body = unexpectedBody(row.shortFingerprint),
            )
            Button(
                onClick = onScan,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 8.dp)
                    .heightIn(min = 44.dp),
            ) {
                Text(ConnectionSecurityCopy.SCAN_QR_AGAIN)
            }
            OutlinedButton(
                onClick = onRemove,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 8.dp)
                    .heightIn(min = 44.dp),
            ) {
                Text(ConnectionSecurityCopy.REMOVE_MACHINE)
            }
            TextButton(
                onClick = onDismiss,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 8.dp)
                    .heightIn(min = 44.dp),
            ) {
                Text(ConnectionSecurityCopy.NOT_NOW)
            }
        }
    }
}

/** The interception sentence with the pinned short fingerprint set in mono. */
private fun unexpectedBody(fingerprint: String?): AnnotatedString {
    val (before, after) = ConnectionSecurityCopy.CERTIFICATE_UNEXPECTED_BODY.split("{fingerprint}")
    return buildAnnotatedString {
        append(before)
        withStyle(SpanStyle(fontFamily = GeistMono, color = TextPrimary)) { append(fingerprint ?: "?") }
        append(after)
    }
}

@Composable
private fun SheetCard(title: String, body: AnnotatedString) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(bottom = 8.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(Surface)
            .padding(horizontal = 14.dp, vertical = 12.dp),
    ) {
        Text(title, style = MaterialTheme.typography.titleSmall)
        Text(
            text = body,
            color = TextDim,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.padding(top = 2.dp),
        )
    }
}

object ConnectionsAccessibilityPolicy {
    fun contentDescription(row: ConnectionRowPresentation): String =
        "${row.label}, ${row.target}"

    fun stateDescription(row: ConnectionRowPresentation): String = listOfNotNull(
        row.statusLabel,
        ConnectionSecurityPolicy.label(row.security),
        row.shortFingerprint,
        ConnectionsListPolicy.statusDetail(row),
    ).joinToString(", ")

    fun longClickLabel(row: ConnectionRowPresentation): String = "Show actions for ${row.label}"

    fun clickLabel(row: ConnectionRowPresentation): String =
        if (row.security == ConnectionSecurity.CERTIFICATE_CHANGED) {
            "Show what changed on ${row.label}"
        } else {
            "Open ${row.label}"
        }
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
