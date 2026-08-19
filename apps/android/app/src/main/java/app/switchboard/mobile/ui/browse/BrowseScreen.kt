package app.switchboard.mobile.ui.browse

import androidx.compose.foundation.background
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Search
import app.switchboard.mobile.domain.remote.Conversation
import app.switchboard.mobile.domain.remote.Project
import app.switchboard.mobile.ui.theme.Accent
import app.switchboard.mobile.ui.theme.Amber
import app.switchboard.mobile.ui.theme.Green
import app.switchboard.mobile.ui.theme.Red
import app.switchboard.mobile.ui.theme.Surface
import app.switchboard.mobile.ui.theme.SurfaceRaised
import app.switchboard.mobile.ui.theme.TextDim
import app.switchboard.mobile.ui.components.InlineStatus
import app.switchboard.mobile.ui.components.InlineStatusProgress
import app.switchboard.mobile.ui.components.SectionLabel
import app.switchboard.mobile.ui.components.StatusTone
import app.switchboard.mobile.ui.components.SwitchboardEmptyState
import java.text.DateFormat
import java.util.Date

@Composable
fun BrowseScreen(
    state: BrowseState,
    route: BrowseRoute,
    onProjectTap: (Project) -> Unit,
    onSessionTap: (Conversation) -> Unit,
    onRetry: (BrowseRequest) -> Unit,
    onBack: () -> Unit,
    onMessageSearch: () -> Unit = {},
    onNewSession: (String, String) -> Unit = { _, _ -> },
    onRenameConversation: (String, String, String) -> Unit = { _, _, _ -> },
    onToggleWorkspace: (String) -> Unit = {},
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .semantics { isTraversalGroup = true },
    ) {
        when (route) {
            BrowseRoute.Projects -> {
                BrowseTopBar(
                    title = state.connectionLabel,
                    onBack = onBack,
                    onMessageSearch = onMessageSearch,
                )
                ProjectsSurface(
                    presentation = BrowsePresenter.projects(state.projects, state.threadActivity),
                    workspaces = BrowsePresenter.workspaces(state.workspaces),
                    collapsedWorkspaceIds = state.collapsedWorkspaceIds,
                    onProjectTap = { row ->
                        onProjectTap(row.project)
                    },
                    onRetry = { onRetry(BrowseRequest.Projects) },
                    onToggleWorkspace = onToggleWorkspace,
                )
            }

            is BrowseRoute.Conversations -> {
                BrowseTopBar(
                    title = route.projectName,
                    onBack = onBack,
                    onMessageSearch = onMessageSearch,
                    actionLabel = "New",
                    onAction = { onNewSession(route.projectPath, route.projectName) },
                )
                ConversationsSurface(
                    presentation = BrowsePresenter.conversations(
                        state = state.conversationsByProject[route.projectPath]
                            ?: BrowseLoadState.Loading(),
                        offlineIndex = OfflineBrowseIndex.from(
                            state.offlineSnapshot,
                            state.connectionId,
                        ),
                        activity = state.threadActivity,
                    ),
                    projectName = route.projectName,
                    onSessionTap = { onSessionTap(it.conversation) },
                    onRetry = { onRetry(BrowseRequest.Conversations(route.projectPath)) },
                    onRename = { row, title ->
                        onRenameConversation(route.projectPath, row.id, title)
                    },
                    renameErrors = state.renameErrors,
                )
            }
        }
    }
}

@Composable
@OptIn(ExperimentalMaterial3Api::class)
private fun BrowseTopBar(
    title: String,
    onBack: () -> Unit,
    onMessageSearch: () -> Unit,
    actionLabel: String? = null,
    onAction: () -> Unit = {},
) {
    TopAppBar(
        title = {
            Text(
                text = title,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.semantics { heading() },
            )
        },
        navigationIcon = {
            IconButton(onClick = onBack, modifier = Modifier.size(48.dp)) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
            }
        },
        actions = {
            IconButton(
                onClick = onMessageSearch,
                modifier = Modifier
                    .size(48.dp)
                    .semantics { contentDescription = "Search messages" },
            ) {
                Icon(Icons.Default.Search, contentDescription = null)
            }
            actionLabel?.let { label ->
                IconButton(
                    onClick = onAction,
                    modifier = Modifier
                        .size(48.dp)
                        .semantics { contentDescription = label },
                ) {
                    Icon(Icons.Default.Add, contentDescription = null)
                }
            }
        },
        colors = TopAppBarDefaults.topAppBarColors(containerColor = Surface),
    )
}

@Composable
@OptIn(ExperimentalMaterial3Api::class)
private fun ProjectsSurface(
    presentation: BrowseProjectsPresentation,
    workspaces: List<app.switchboard.mobile.domain.remote.Workspace>,
    collapsedWorkspaceIds: Set<String>,
    onProjectTap: (BrowseProjectRow) -> Unit,
    onRetry: () -> Unit,
    onToggleWorkspace: (String) -> Unit,
) {
    when (presentation) {
        BrowseProjectsPresentation.Loading -> FullPageLoading("Loading projects")
        BrowseProjectsPresentation.Empty -> FullPageEmpty(
            title = "No projects",
            detail = "Add a project on the desktop app to see it here.",
        )

        is BrowseProjectsPresentation.Failure -> FullPageFailure(
            message = presentation.message,
            onRetry = onRetry,
        )

        is BrowseProjectsPresentation.Content -> {
            var query by rememberSaveable { mutableStateOf("") }
            val sections = remember(
                presentation.rows,
                workspaces,
                collapsedWorkspaceIds,
                query,
            ) {
                BrowseParityDecisions.sections(
                    projects = presentation.rows.map(BrowseProjectRow::project),
                    workspaces = workspaces,
                    collapsedWorkspaceIds = collapsedWorkspaceIds,
                    query = query,
                )
            }
            val byPath = remember(presentation.rows) { presentation.rows.associateBy { it.path } }
            PullToRefreshBox(
                isRefreshing = presentation.status.showProgress,
                onRefresh = onRetry,
                modifier = Modifier.fillMaxSize(),
            ) {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(bottom = 24.dp),
                ) {
                    item { BrowseStatusRow(presentation.status, onRetry) }
                    if (BrowseParityDecisions.showProjectSearch(presentation.rows.size, query)) {
                        item {
                            BrowseSearchField(
                                value = query,
                                onValueChange = { query = it },
                                label = "Search projects",
                            )
                        }
                    }
                    sections.forEach { section ->
                        if (sections.size > 1) {
                            item(key = "workspace:${section.key}") {
                                WorkspaceHeader(
                                    section = section,
                                    onToggle = { onToggleWorkspace(section.key) },
                                    toggleEnabled = query.isBlank(),
                                )
                            }
                        }
                        items(section.projects, key = Project::path) { project ->
                            val row = requireNotNull(byPath[project.path])
                            ProjectRow(row = row, onClick = { onProjectTap(row) })
                            HorizontalDivider(modifier = Modifier.padding(start = 76.dp))
                        }
                    }
                }
            }
        }
    }
}

@Composable
@OptIn(ExperimentalMaterial3Api::class)
private fun ConversationsSurface(
    presentation: BrowseConversationsPresentation,
    projectName: String,
    onSessionTap: (BrowseConversationRow) -> Unit,
    onRetry: () -> Unit,
    onRename: (BrowseConversationRow, String) -> Unit,
    renameErrors: Map<String, String>,
) {
    when (presentation) {
        BrowseConversationsPresentation.Loading -> FullPageLoading("Loading conversations")
        BrowseConversationsPresentation.Empty -> FullPageEmpty(
            title = "No conversations",
            detail = "Start a session in $projectName on the desktop app to see it here.",
        )

        is BrowseConversationsPresentation.Failure -> FullPageFailure(
            message = presentation.message,
            onRetry = onRetry,
        )

        is BrowseConversationsPresentation.Content -> {
            var query by rememberSaveable { mutableStateOf("") }
            var renaming by remember { mutableStateOf<BrowseConversationRow?>(null) }
            val visible = remember(presentation.rows, query) {
                presentation.rows.filter {
                    BrowseParityDecisions.conversationTitleMatches(it.title, query)
                }
            }
            PullToRefreshBox(
                isRefreshing = presentation.status.showProgress,
                onRefresh = onRetry,
                modifier = Modifier.fillMaxSize(),
            ) {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(bottom = 24.dp),
                ) {
                    item { BrowseStatusRow(presentation.status, onRetry) }
                    if (BrowseParityDecisions.showConversationSearch(presentation.rows.size, query)) {
                        item {
                            BrowseSearchField(
                                value = query,
                                onValueChange = { query = it },
                                label = "Search conversations",
                            )
                        }
                    }
                    items(visible, key = BrowseConversationRow::id) { row ->
                        ConversationRow(
                            row = row,
                            onClick = { onSessionTap(row) },
                            onLongClick = { renaming = row },
                        )
                        RenameErrorSlot(renameErrors[row.id])
                        HorizontalDivider(modifier = Modifier.padding(start = 52.dp))
                    }
                }
            }
            renaming?.let { row ->
                RenameConversationDialog(
                    initialTitle = row.title,
                    onDismiss = { renaming = null },
                    onConfirm = { title ->
                        onRename(row, title)
                        renaming = null
                    },
                )
            }
        }
    }
}

@Composable
private fun BrowseStatusRow(status: BrowseStatus, onRetry: () -> Unit) {
    if (status.kind == BrowseStatusKind.NORMAL && !status.showProgress && status.detail == null) {
        SectionLabel(
            text = status.label,
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp),
        )
        return
    }
    InlineStatus(
        message = status.label,
        detail = status.detail,
        tone = when (status.kind) {
            BrowseStatusKind.NORMAL -> StatusTone.NEUTRAL
            BrowseStatusKind.CACHED -> StatusTone.INFO
            BrowseStatusKind.ERROR -> StatusTone.ERROR
        },
        progress = if (status.showProgress) InlineStatusProgress.Indeterminate else InlineStatusProgress.None,
        actionLabel = "Retry".takeIf { status.canRetry },
        onAction = onRetry.takeIf { status.canRetry },
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
    )
}

@Composable
private fun ProjectRow(row: BrowseProjectRow, onClick: () -> Unit) {
    ListItem(
        headlineContent = {
            Text(row.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
        },
        supportingContent = {
            Text(row.path, maxLines = 1, overflow = TextOverflow.Ellipsis)
        },
        leadingContent = { ProjectMonogram(row.name) },
        trailingContent = { ActivityTrailing(row.status, row.unread, BrowseRowPolicy.projectTrailingLabel(row)) },
        colors = ListItemDefaults.colors(containerColor = Surface),
        modifier = Modifier
            .heightIn(min = 68.dp)
            .semantics(mergeDescendants = true) {
                contentDescription = BrowseAccessibilityPolicy.projectDescription(row.name, row.sessionCount)
                stateDescription = BrowseAccessibilityPolicy.projectState(row.unread, row.status)
            }
            .clickable(role = Role.Button, onClickLabel = "Open ${row.name}", onClick = onClick),
    )
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ConversationRow(
    row: BrowseConversationRow,
    onClick: () -> Unit,
    onLongClick: () -> Unit,
) {
    ListItem(
        headlineContent = { Text(row.title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        supportingContent = {
            Text(
                BrowseRowPolicy.conversationSupportingLabel(row),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        },
        leadingContent = { ActivityDot(BrowseVisualPolicy.activityTone(row.status, row.unread)) },
        trailingContent = {
            Column(horizontalAlignment = Alignment.End) {
                Text(
                    remember(row.updatedAt) { formatTimestamp(row.updatedAt) },
                    color = TextDim,
                    style = MaterialTheme.typography.labelSmall,
                )
                if (row.unread > 0) UnreadBadge(row.unread, Modifier.padding(top = 5.dp))
                else Icon(Icons.Default.KeyboardArrowRight, contentDescription = null, tint = TextDim)
            }
        },
        colors = ListItemDefaults.colors(containerColor = Surface),
        modifier = Modifier
            .heightIn(min = 68.dp)
            .semantics(mergeDescendants = true) {
                contentDescription = BrowseAccessibilityPolicy.conversationDescription(row.title, row.agentType)
                stateDescription = BrowseAccessibilityPolicy.conversationState(
                    row.availableOffline,
                    row.unread,
                    row.status,
                )
            }
            .combinedClickable(
                role = Role.Button,
                onClickLabel = "Open ${row.title}",
                onLongClickLabel = "Rename ${row.title}",
                onClick = onClick,
                onLongClick = onLongClick,
            ),
    )
}

@Composable
private fun ProjectMonogram(name: String) {
    Box(
        modifier = Modifier
            .size(40.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(SurfaceRaised)
            .clearAndSetSemantics {},
        contentAlignment = Alignment.Center,
    ) {
        Text(BrowseVisualPolicy.projectMonogram(name), color = TextDim, style = MaterialTheme.typography.labelMedium)
    }
}

@Composable
private fun ActivityTrailing(status: String?, unread: Int, fallback: String) {
    if (unread > 0) {
        UnreadBadge(unread)
    } else {
        Row(verticalAlignment = Alignment.CenterVertically) {
            ActivityDot(BrowseVisualPolicy.activityTone(status, unread))
            Text(fallback, color = TextDim, style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(start = 8.dp))
        }
    }
}

@Composable
private fun ActivityDot(tone: BrowseActivityTone) {
    val color = when (tone) {
        BrowseActivityTone.ACTIVE -> Green
        BrowseActivityTone.ATTENTION -> Amber
        BrowseActivityTone.ERROR -> Red
        BrowseActivityTone.UNREAD -> Accent
        BrowseActivityTone.MUTED -> TextDim
    }
    Box(
        Modifier
            .size(8.dp)
            .clip(CircleShape)
            .background(color)
            .clearAndSetSemantics {},
    )
}

@Composable
private fun UnreadBadge(unread: Int, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .size(24.dp)
            .clip(CircleShape)
            .background(Accent)
            .clearAndSetSemantics {},
        contentAlignment = Alignment.Center,
    ) {
        Text(unread.coerceAtMost(99).toString(), color = MaterialTheme.colorScheme.onPrimary, style = MaterialTheme.typography.labelSmall)
    }
}

@Composable
private fun BrowseSearchField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
) {
    TextField(
        value = value,
        onValueChange = onValueChange,
        placeholder = { Text(label) },
        leadingIcon = { Icon(Icons.Default.Search, contentDescription = null, tint = TextDim) },
        singleLine = true,
        shape = RoundedCornerShape(14.dp),
        colors = TextFieldDefaults.colors(
            focusedContainerColor = SurfaceRaised,
            unfocusedContainerColor = SurfaceRaised,
            focusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
            unfocusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
        ),
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp)
            .semantics { contentDescription = label },
    )
}

@Composable
private fun WorkspaceHeader(
    section: BrowseProjectSection,
    onToggle: () -> Unit,
    toggleEnabled: Boolean,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .semantics(mergeDescendants = true) {
                contentDescription = section.name
                stateDescription = BrowseAccessibilityPolicy.workspaceState(section.collapsed)
            }
            .clickable(
                enabled = toggleEnabled,
                role = Role.Button,
                onClickLabel = if (section.collapsed) "Expand ${section.name}" else "Collapse ${section.name}",
                onClick = onToggle,
            )
            .padding(horizontal = 20.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        SectionLabel(text = section.name, modifier = Modifier.weight(1f))
        if (toggleEnabled) {
            Text(section.projectCount.toString(), color = TextDim, style = MaterialTheme.typography.labelSmall)
            Icon(
                imageVector = if (section.collapsed) Icons.Default.KeyboardArrowDown else Icons.Default.KeyboardArrowUp,
                contentDescription = null,
                tint = TextDim,
                modifier = Modifier.padding(start = 8.dp),
            )
        }
    }
}

@Composable
private fun RenameErrorSlot(message: String?) {
    if (message == null) return
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 24.dp)
            .padding(horizontal = 20.dp),
    ) {
        Text(
            text = message,
            color = Red,
            style = MaterialTheme.typography.labelSmall,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        )
    }
}

object BrowseAccessibilityPolicy {
    fun projectDescription(name: String, sessionCount: Int): String =
        "$name, $sessionCount ${if (sessionCount == 1) "session" else "sessions"}"

    fun projectState(unread: Int, status: String?): String = listOfNotNull(
        unread.takeIf { it > 0 }?.let { "$it unread" },
        status?.takeIf(String::isNotBlank),
    ).joinToString(", ")

    fun conversationDescription(title: String, agentType: String): String =
        "$title, ${agentLabel(agentType)}"

    fun conversationState(availableOffline: Boolean, unread: Int, status: String?): String =
        listOfNotNull(
            "saved offline".takeIf { availableOffline },
            unread.takeIf { it > 0 }?.let { "$it unread" },
            status?.takeIf(String::isNotBlank),
        ).joinToString(", ")

    fun workspaceState(collapsed: Boolean): String = if (collapsed) "Collapsed" else "Expanded"

    private fun agentLabel(agentType: String): String = when (agentType) {
        "claude", "claude-code" -> "Claude"
        "codex" -> "Codex"
        "opencode" -> "OpenCode"
        else -> agentType
    }
}

@Composable
private fun RenameConversationDialog(
    initialTitle: String,
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit,
) {
    var title by rememberSaveable(initialTitle) { mutableStateOf(initialTitle) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Rename conversation") },
        text = {
            OutlinedTextField(
                value = title,
                onValueChange = { title = it },
                singleLine = true,
                label = { Text("Title") },
            )
        },
        confirmButton = {
            TextButton(
                onClick = { onConfirm(title) },
                enabled = title.trim().isNotEmpty() && title.trim() != initialTitle,
            ) { Text("Rename") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun FullPageLoading(label: String) {
    Column(
        modifier = Modifier.fillMaxSize(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        CircularProgressIndicator(modifier = Modifier.size(28.dp), strokeWidth = 2.dp)
        Text(
            text = label,
            color = TextDim,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.padding(top = 16.dp),
        )
    }
}

@Composable
private fun FullPageEmpty(title: String, detail: String) {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        SwitchboardEmptyState(title = title, body = detail)
    }
}

@Composable
private fun FullPageFailure(message: String, onRetry: () -> Unit) {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        SwitchboardEmptyState(
            title = "Could not load",
            body = message,
            actionLabel = "Retry",
            onAction = onRetry,
        )
    }
}

private fun formatTimestamp(updatedAt: Long): String =
    DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(updatedAt))
