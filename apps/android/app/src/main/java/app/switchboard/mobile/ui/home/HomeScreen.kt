package app.switchboard.mobile.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
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
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.switchboard.mobile.platform.google.GoogleAccountPresentation
import app.switchboard.mobile.ui.components.InlineStatus
import app.switchboard.mobile.ui.components.InlineStatusProgress
import app.switchboard.mobile.ui.components.SectionLabel
import app.switchboard.mobile.ui.components.StatusTone
import app.switchboard.mobile.ui.connections.ConnectionRowPresentation
import app.switchboard.mobile.ui.connections.ConnectionStatus
import app.switchboard.mobile.ui.connections.ConnectionsPresentation
import app.switchboard.mobile.ui.connections.GoogleAccountAvatarPolicy
import app.switchboard.mobile.ui.theme.Accent
import app.switchboard.mobile.ui.theme.Amber
import app.switchboard.mobile.ui.theme.GeistMono
import app.switchboard.mobile.ui.theme.Green
import app.switchboard.mobile.ui.theme.Red
import app.switchboard.mobile.ui.theme.TextDim
import java.text.DateFormat
import java.util.Date

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
    modifier: Modifier = Modifier,
) {
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
            if (recents.items.isEmpty()) {
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
                    RecentRow(row = row, onClick = { onRecent(row) })
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
                        HomeMachineRow(row = row, onClick = { onMachine(row.id) })
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

@Composable
private fun RecentRow(row: HomeRecentRow, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 68.dp)
            .clip(RoundedCornerShape(8.dp))
            .clickable(role = Role.Button, onClick = onClick)
            .padding(vertical = 10.dp),
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
        HomeRecentTrailing(row)
    }
}

@Composable
private fun HomeRecentTrailing(row: HomeRecentRow) {
    val status = row.status
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
        HomeRecentStatus.Approval, HomeRecentStatus.Input -> Amber
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
private fun HomeMachineRow(row: ConnectionRowPresentation, onClick: () -> Unit) {
    val tint = when (row.status) {
        ConnectionStatus.LIVE -> Green
        ConnectionStatus.CONNECTING -> Amber
        ConnectionStatus.OFFLINE -> TextDim
        ConnectionStatus.ERROR -> Red
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 64.dp)
            .clip(RoundedCornerShape(8.dp))
            .clickable(role = Role.Button, onClick = onClick)
            .semantics(mergeDescendants = true) {
                contentDescription = "${row.label}, ${row.statusLabel}"
            }
            .padding(vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(7.dp)
                .clip(CircleShape)
                .background(tint),
        )
        Text(
            text = row.label,
            style = MaterialTheme.typography.titleMedium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .weight(1f)
                .padding(horizontal = 12.dp),
        )
        Text(
            text = row.statusLabel,
            color = TextDim,
            style = MaterialTheme.typography.bodySmall,
        )
        Icon(
            Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = null,
            tint = TextDim,
            modifier = Modifier.padding(start = 4.dp),
        )
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
