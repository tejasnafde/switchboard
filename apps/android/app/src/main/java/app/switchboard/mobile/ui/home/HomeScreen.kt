package app.switchboard.mobile.ui.home

import androidx.compose.animation.core.animate
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.switchboard.mobile.domain.remote.ChatSnooze
import app.switchboard.mobile.platform.google.GoogleAccountPresentation
import app.switchboard.mobile.ui.components.InlineStatus
import app.switchboard.mobile.ui.components.InlineStatusProgress
import app.switchboard.mobile.ui.components.SectionLabel
import app.switchboard.mobile.ui.components.StatusTone
import app.switchboard.mobile.domain.connection.ConnectionSecurity
import app.switchboard.mobile.ui.connections.CertificateChangedSheet
import app.switchboard.mobile.ui.connections.ConnectionRow
import app.switchboard.mobile.ui.connections.ConnectionRowPresentation
import app.switchboard.mobile.ui.connections.ConnectionsPresentation
import app.switchboard.mobile.ui.connections.GoogleAccountAvatarPolicy
import app.switchboard.mobile.ui.connections.RefusedHint
import app.switchboard.mobile.ui.connections.RemoveMachineDialog
import app.switchboard.mobile.ui.demo.TryDemoButton
import app.switchboard.mobile.ui.theme.Accent
import app.switchboard.mobile.ui.theme.Amber
import app.switchboard.mobile.ui.theme.GeistMono
import app.switchboard.mobile.ui.theme.Green
import app.switchboard.mobile.ui.theme.Red
import app.switchboard.mobile.ui.theme.TextDim
import java.text.DateFormat
import java.util.Date
import kotlin.math.roundToInt
import kotlinx.coroutines.launch

@Composable
fun HomeScreen(
    recents: HomeRecentsPage,
    machines: ConnectionsPresentation,
    googleAccount: GoogleAccountPresentation,
    onRecent: (HomeRecentRow) -> Unit,
    onMachine: (String) -> Unit,
    onShowMore: () -> Unit,
    onManageMachines: () -> Unit,
    onAddMachine: () -> Unit,
    onGoogleAccount: () -> Unit,
    onSettings: () -> Unit,
    onRetryMachines: () -> Unit,
    onRescan: (String) -> Unit,
    onUseIap: () -> Unit,
    onRemoveMachine: (String) -> Unit,
    modifier: Modifier = Modifier,
    onTryDemo: (() -> Unit)? = null,
    snoozeSheet: HomeSnoozeSheet? = null,
    /** Opens the Snooze sheet of a row; null when no machine can snooze. */
    onSnooze: ((HomeRecentRow) -> Unit)? = null,
    onPickSnooze: (HomeSnoozeItem) -> Unit = {},
    onCloseSnooze: () -> Unit = {},
    onWake: (HomeRecentRow) -> Unit = {},
    /** A Wake that did not happen. */
    snoozeNotice: String? = null,
) {
    var certificateRow by remember { mutableStateOf<ConnectionRowPresentation?>(null) }
    var removeRow by remember { mutableStateOf<ConnectionRowPresentation?>(null) }
    var shelfOpen by rememberSaveable { mutableStateOf(false) }
    Column(modifier = modifier.fillMaxSize()) {
        HomeTopBar(
            googleAccount = googleAccount,
            onGoogleAccount = onGoogleAccount,
            onAddMachine = onAddMachine,
            onSettings = onSettings,
        )
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(start = 20.dp, end = 20.dp, bottom = 120.dp),
        ) {
            item { HomeSectionHeader("RECENTS") }
            snoozeNotice?.let { notice ->
                item {
                    Text(
                        text = notice,
                        color = Amber,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier
                            .padding(vertical = 8.dp)
                            .semantics { liveRegion = LiveRegionMode.Polite },
                    )
                }
            }
            if (recents.items.isEmpty() && recents.snoozed.isEmpty()) {
                item {
                    Text(
                        text = "No recent chats yet",
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.padding(top = 14.dp),
                    )
                    Text(
                        text = "Open a machine and choose a project to start or resume a chat.",
                        color = TextDim,
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.padding(top = 5.dp, bottom = 12.dp),
                    )
                }
            } else {
                items(recents.items, key = { "${it.connectionId}:${it.threadId}" }) { row ->
                    RecentRow(
                        row = row,
                        onClick = { onRecent(row) },
                        onSnooze = onSnooze?.takeIf { row.canSnooze }?.let { open -> { open(row) } },
                    )
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.55f))
                }
                if (recents.hasMore) {
                    item {
                        TextButton(
                            onClick = onShowMore,
                            modifier = Modifier
                                .fillMaxWidth()
                                .heightIn(min = 48.dp),
                        ) {
                            Text("Show more")
                        }
                    }
                }
                if (recents.snoozed.isNotEmpty()) {
                    item(key = "snoozed-shelf") {
                        SnoozedShelf(
                            count = recents.snoozed.size,
                            open = shelfOpen,
                            onToggle = { shelfOpen = !shelfOpen },
                        )
                    }
                    if (shelfOpen) {
                        items(recents.snoozed, key = { "snoozed:${it.connectionId}:${it.threadId}" }) { row ->
                            SnoozedRow(row = row, onClick = { onRecent(row) }, onWake = { onWake(row) })
                            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.55f))
                        }
                    }
                }
            }

            item {
                HomeSectionHeader(
                    label = "MACHINES",
                    action = "Manage",
                    onAction = onManageMachines,
                )
            }
            when (machines) {
                ConnectionsPresentation.Loading -> item {
                    InlineStatus(
                        message = "Loading machines",
                        progress = InlineStatusProgress.Indeterminate,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }

                ConnectionsPresentation.Empty -> item {
                    InlineStatus(
                        message = "Nothing paired yet",
                        detail = "Add a machine to reach its projects and chats.",
                        actionLabel = "Add",
                        onAction = onAddMachine,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    onTryDemo?.let { TryDemoButton(onClick = it, modifier = Modifier.padding(top = 12.dp)) }
                }

                is ConnectionsPresentation.Failure -> item {
                    InlineStatus(
                        message = "Could not load machines",
                        detail = machines.message,
                        tone = StatusTone.ERROR,
                        actionLabel = "Retry",
                        onAction = onRetryMachines,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }

                is ConnectionsPresentation.Content -> {
                    items(machines.rows.take(HOME_MACHINE_LIMIT), key = { it.id }) { row ->
                        ConnectionRow(
                            row = row,
                            onOpen = {
                                if (row.security == ConnectionSecurity.CERTIFICATE_CHANGED) {
                                    certificateRow = row
                                } else {
                                    onMachine(row.id)
                                }
                            },
                        )
                        if (row.security == ConnectionSecurity.REFUSED) {
                            RefusedHint(onScan = { onRescan(row.id) }, onUseIap = onUseIap)
                        }
                        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.55f))
                    }
                    machines.recoveryMessage?.let { message ->
                        item {
                            InlineStatus(
                                message = "Some machines need attention",
                                detail = message,
                                tone = StatusTone.WARNING,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(top = 12.dp),
                            )
                        }
                    }
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

    snoozeSheet?.let { sheet ->
        SnoozeSheet(sheet = sheet, onPick = onPickSnooze, onDismiss = onCloseSnooze)
    }

    removeRow?.let { row ->
        RemoveMachineDialog(
            row = row,
            onRemove = {
                removeRow = null
                onRemoveMachine(row.id)
            },
            onDismiss = { removeRow = null },
        )
    }
}

@Composable
private fun HomeTopBar(
    googleAccount: GoogleAccountPresentation,
    onGoogleAccount: () -> Unit,
    onAddMachine: () -> Unit,
    onSettings: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .statusBarsPadding()
            .heightIn(min = 56.dp)
            .padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(
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
            } ?: Icon(Icons.Filled.AccountCircle, contentDescription = null)
        }
        Spacer(Modifier.width(8.dp))
        Text(
            text = "Switchboard",
            style = MaterialTheme.typography.titleLarge,
            modifier = Modifier
                .weight(1f)
                .semantics { heading() },
        )
        IconButton(
            onClick = onSettings,
            modifier = Modifier
                .size(48.dp)
                .semantics { contentDescription = "Settings" },
        ) {
            Icon(Icons.Default.Settings, contentDescription = null)
        }
        IconButton(
            onClick = onAddMachine,
            modifier = Modifier
                .size(48.dp)
                .semantics { contentDescription = "Add machine" },
        ) {
            Icon(Icons.Default.Add, contentDescription = null)
        }
    }
}

@Composable
private fun HomeSectionHeader(
    label: String,
    action: String? = null,
    onAction: () -> Unit = {},
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 24.dp, bottom = 8.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        SectionLabel(label)
        action?.let {
            TextButton(onClick = onAction, modifier = Modifier.heightIn(min = 44.dp)) {
                Text(it)
            }
        }
    }
}

/** A row of Recents. With [onSnooze], a long press or a leftward swipe opens its Snooze sheet; the row springs back. */
@Composable
private fun RecentRow(row: HomeRecentRow, onClick: () -> Unit, onSnooze: (() -> Unit)?) {
    val density = LocalDensity.current
    val scope = rememberCoroutineScope()
    val currentOnSnooze by rememberUpdatedState(onSnooze)
    var dragX by remember { mutableFloatStateOf(0f) }
    val dragState = rememberDraggableState { delta -> dragX = (dragX + delta).coerceAtMost(0f) }
    val press = if (onSnooze == null) {
        Modifier.clickable(role = Role.Button, onClick = onClick)
    } else {
        Modifier
            .draggable(
                state = dragState,
                orientation = Orientation.Horizontal,
                onDragStopped = { velocity ->
                    val commitPx = with(density) { SWIPE_COMMIT.toPx() }
                    val flingPx = with(density) { SWIPE_FLING.toPx() }
                    if (dragX <= -commitPx || velocity <= -flingPx) currentOnSnooze?.invoke()
                    scope.launch { animate(dragX, 0f) { value, _ -> dragX = value } }
                },
            )
            .combinedClickable(
                role = Role.Button,
                onLongClickLabel = "Snooze",
                onClick = onClick,
                onLongClick = onSnooze,
            )
    }
    Row(
        modifier = Modifier
            .offset { IntOffset(dragX.roundToInt(), 0) }
            .fillMaxWidth()
            .heightIn(min = 68.dp)
            .clip(RoundedCornerShape(8.dp))
            .then(press)
            .padding(vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = row.title,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = if (row.woke) FontWeight.Bold else null,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = "${row.projectName} · ${row.connectionLabel}",
                color = TextDim,
                style = MaterialTheme.typography.bodySmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 3.dp),
            )
        }
        HomeRecentTrailing(row)
    }
}

@Composable
private fun HomeRecentTrailing(row: HomeRecentRow) {
    val status = row.status
    if (row.woke && (status == null || status == HomeRecentStatus.Done)) {
        Text(
            text = "Woke",
            color = Accent,
            fontFamily = GeistMono,
            fontSize = 11.sp,
            modifier = Modifier.padding(start = 12.dp),
        )
        return
    }
    if (status == null) {
        Text(
            text = homeRelativeTime(row.startedAt),
            color = TextDim,
            fontFamily = GeistMono,
            fontSize = 11.sp,
            modifier = Modifier.padding(start = 12.dp),
        )
        return
    }
    val color = when (status) {
        HomeRecentStatus.Approval, HomeRecentStatus.Input, HomeRecentStatus.Plan -> Amber
        HomeRecentStatus.Working -> Accent
        HomeRecentStatus.Failed -> Red
        HomeRecentStatus.Done -> Green
    }
    Row(
        modifier = Modifier.padding(start = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (status == HomeRecentStatus.Working) {
            CircularProgressIndicator(
                modifier = Modifier.size(10.dp),
                color = color,
                strokeWidth = 1.5.dp,
            )
        } else {
            Box(
                modifier = Modifier
                    .size(7.dp)
                    .clip(CircleShape)
                    .background(color),
            )
        }
        Text(
            text = status.label,
            color = color,
            fontFamily = GeistMono,
            fontSize = 11.sp,
            modifier = Modifier.padding(start = 6.dp),
        )
    }
}

@Composable
private fun SnoozedShelf(count: Int, open: Boolean, onToggle: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .clip(RoundedCornerShape(8.dp))
            .clickable(role = Role.Button, onClick = onToggle)
            .semantics { stateDescription = if (open) "Expanded" else "Collapsed" },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = if (open) Icons.Default.KeyboardArrowDown else Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = null,
            tint = TextDim,
            modifier = Modifier.size(18.dp),
        )
        Text(
            text = "Snoozed $count",
            color = TextDim,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.padding(start = 6.dp),
        )
    }
}

/** A snoozed chat: a tap opens it, Wake ends the snooze. */
@Composable
private fun SnoozedRow(row: HomeRecentRow, onClick: () -> Unit, onWake: () -> Unit) {
    val now = System.currentTimeMillis()
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 60.dp)
            .clip(RoundedCornerShape(8.dp))
            .clickable(role = Role.Button, onClick = onClick)
            .padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = row.title,
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = "${row.projectName} · ${row.connectionLabel}",
                color = TextDim,
                style = MaterialTheme.typography.bodySmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 3.dp),
            )
        }
        Text(
            text = ChatSnooze.wakeLabel(row.snooze.snoozedUntil, row.snooze.snoozePr, now),
            color = TextDim,
            fontFamily = GeistMono,
            fontSize = 11.sp,
            modifier = Modifier.padding(start = 12.dp),
        )
        TextButton(
            onClick = onWake,
            modifier = Modifier
                .heightIn(min = 48.dp)
                .semantics { contentDescription = "Wake ${row.title}" },
        ) {
            Text("Wake")
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SnoozeSheet(sheet: HomeSnoozeSheet, onPick: (HomeSnoozeItem) -> Unit, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Text(
            text = "Snooze",
            style = MaterialTheme.typography.titleMedium,
            modifier = Modifier
                .padding(horizontal = 24.dp)
                .semantics { heading() },
        )
        Text(
            text = sheet.row.title,
            color = TextDim,
            style = MaterialTheme.typography.bodySmall,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(start = 24.dp, end = 24.dp, top = 2.dp, bottom = 8.dp),
        )
        sheet.items.forEach { item ->
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 52.dp)
                    .clickable(enabled = !sheet.busy, role = Role.Button) { onPick(item) }
                    .padding(horizontal = 24.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = item.label,
                    style = MaterialTheme.typography.bodyLarge,
                    modifier = Modifier.weight(1f),
                )
                if (item.detail.isNotEmpty()) {
                    Text(text = item.detail, color = TextDim, fontFamily = GeistMono, fontSize = 12.sp)
                }
            }
        }
        sheet.notice?.let { notice ->
            Text(
                text = notice,
                color = Amber,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier
                    .padding(horizontal = 24.dp, vertical = 8.dp)
                    .semantics { liveRegion = LiveRegionMode.Polite },
            )
        }
        Spacer(Modifier.height(16.dp))
    }
}

private fun homeRelativeTime(startedAt: Long, now: Long = System.currentTimeMillis()): String {
    if (startedAt <= 0) return ""
    val atMs = if (startedAt < 10_000_000_000L) startedAt * 1_000 else startedAt
    val elapsed = (now - atMs).coerceAtLeast(0)
    return when {
        elapsed < 60_000 -> "now"
        elapsed < 3_600_000 -> "${elapsed / 60_000}m"
        elapsed < 86_400_000 -> "${elapsed / 3_600_000}h"
        elapsed < 604_800_000 -> "${elapsed / 86_400_000}d"
        else -> DateFormat.getDateInstance(DateFormat.SHORT).format(Date(atMs))
    }
}

private const val HOME_MACHINE_LIMIT = 3

/** How far a leftward swipe must go, or how fast, to open the Snooze sheet. */
private val SWIPE_COMMIT = 72.dp
private val SWIPE_FLING = 500.dp
