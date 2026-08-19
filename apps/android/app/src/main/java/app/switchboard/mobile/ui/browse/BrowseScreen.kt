package app.switchboard.mobile.ui.browse

import androidx.compose.foundation.background
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.unit.sp
import app.switchboard.mobile.domain.remote.Conversation
import app.switchboard.mobile.domain.remote.Project
import app.switchboard.mobile.ui.theme.Accent
import app.switchboard.mobile.ui.theme.GeistMono
import app.switchboard.mobile.ui.theme.Red
import app.switchboard.mobile.ui.theme.Surface
import app.switchboard.mobile.ui.theme.SurfaceRaised
import app.switchboard.mobile.ui.theme.TextDim
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
                BrowseTopBar(title = state.connectionLabel, onBack = onBack)
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
private fun BrowseTopBar(
    title: String,
    onBack: () -> Unit,
    actionLabel: String? = null,
    onAction: () -> Unit = {},
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .statusBarsPadding()
            .heightIn(min = 56.dp)
            .padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TextButton(
            onClick = onBack,
            modifier = Modifier.heightIn(min = 48.dp),
        ) {
            Text("Back")
        }
        Text(
            text = title,
            style = MaterialTheme.typography.titleMedium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .weight(1f)
                .padding(start = 8.dp, end = 16.dp)
                .semantics { heading() },
        )
        actionLabel?.let { label ->
            TextButton(
                onClick = onAction,
                modifier = Modifier.heightIn(min = 48.dp),
            ) {
                Text(label)
            }
        }
    }
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
    val color = when (status.kind) {
        BrowseStatusKind.NORMAL -> TextDim
        BrowseStatusKind.CACHED -> Accent
        BrowseStatusKind.ERROR -> Red
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .semantics {
                liveRegion = LiveRegionMode.Polite
                stateDescription = listOfNotNull(status.label, status.detail).joinToString(", ")
            }
            .padding(start = 20.dp, end = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .width(26.dp)
                .clearAndSetSemantics {},
            contentAlignment = Alignment.CenterStart,
        ) {
            if (status.showProgress) {
                CircularProgressIndicator(
                    color = color,
                    strokeWidth = 2.dp,
                    modifier = Modifier.size(16.dp),
                )
            }
        }
        Column(
            modifier = Modifier
                .weight(1f)
                .clearAndSetSemantics {},
        ) {
            Text(
                text = status.label,
                color = color,
                fontFamily = GeistMono,
                fontSize = 11.sp,
                maxLines = 1,
            )
            status.detail?.let { detail ->
                Text(
                    text = detail,
                    color = TextDim,
                    style = MaterialTheme.typography.labelSmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (status.canRetry) {
            TextButton(
                onClick = onRetry,
                modifier = Modifier.heightIn(min = 48.dp),
            ) {
                Text("Retry")
            }
        }
    }
}

@Composable
private fun ProjectRow(row: BrowseProjectRow, onClick: () -> Unit) {
    BrowsePressableRow(
        contentDescription = BrowseAccessibilityPolicy.projectDescription(row.name, row.sessionCount),
        stateDescription = BrowseAccessibilityPolicy.projectState(row.unread, row.status),
        onClickLabel = "Open ${row.name}",
        onClick = onClick,
    ) {
        Column(
            modifier = Modifier
                .weight(1f)
                .clearAndSetSemantics {},
        ) {
            Text(
                text = row.name,
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = row.path,
                color = TextDim,
                style = MaterialTheme.typography.bodySmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 3.dp),
            )
        }
        Text(
            text = BrowseRowPolicy.projectTrailingLabel(row),
            color = if (row.unread > 0) Accent else TextDim,
            style = MaterialTheme.typography.labelMedium,
            modifier = Modifier
                .padding(start = 12.dp)
                .clearAndSetSemantics {},
        )
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ConversationRow(
    row: BrowseConversationRow,
    onClick: () -> Unit,
    onLongClick: () -> Unit,
) {
    BrowsePressableRow(
        contentDescription = BrowseAccessibilityPolicy.conversationDescription(row.title, row.agentType),
        stateDescription = BrowseAccessibilityPolicy.conversationState(
            row.availableOffline,
            row.unread,
            row.status,
        ),
        onClickLabel = "Open ${row.title}",
        onLongClickLabel = "Rename ${row.title}",
        onClick = onClick,
        onLongClick = onLongClick,
    ) {
        Column(
            modifier = Modifier
                .weight(1f)
                .clearAndSetSemantics {},
        ) {
            Text(
                text = row.title,
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(top = 4.dp),
            ) {
                Text(
                    text = BrowseRowPolicy.conversationSupportingLabel(row),
                    color = TextDim,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
        Text(
            text = remember(row.updatedAt) { formatTimestamp(row.updatedAt) },
            color = TextDim,
            modifier = Modifier
                .padding(start = 12.dp)
                .clearAndSetSemantics {},
            style = MaterialTheme.typography.labelSmall,
        )
    }
}

@Composable
private fun BrowsePressableRow(
    contentDescription: String,
    stateDescription: String,
    onClickLabel: String,
    onLongClickLabel: String? = null,
    onClick: () -> Unit,
    onLongClick: (() -> Unit)? = null,
    content: @Composable RowScope.() -> Unit,
) {
    val interactionSource = remember { MutableInteractionSource() }
    val pressed by interactionSource.collectIsPressedAsState()
    val indication = LocalIndication.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 68.dp)
            .background(if (pressed) SurfaceRaised else Surface)
            .semantics(mergeDescendants = true) {
                this.contentDescription = contentDescription
                if (stateDescription.isNotBlank()) this.stateDescription = stateDescription
            }
            .then(
                if (onLongClick == null) {
                    Modifier.clickable(
                        interactionSource = interactionSource,
                        indication = indication,
                        role = Role.Button,
                        onClickLabel = onClickLabel,
                        onClick = onClick,
                    )
                } else {
                    Modifier.combinedClickable(
                        interactionSource = interactionSource,
                        indication = indication,
                        role = Role.Button,
                        onClickLabel = onClickLabel,
                        onLongClickLabel = onLongClickLabel,
                        onClick = onClick,
                        onLongClick = onLongClick,
                    )
                },
            )
            .padding(horizontal = 20.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        content = content,
    )
}

@Composable
private fun BrowseSearchField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        singleLine = true,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp),
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
        Text(
            text = section.name,
            style = MaterialTheme.typography.labelLarge,
            modifier = Modifier.weight(1f),
        )
        if (toggleEnabled) {
            Text(if (section.collapsed) "Show" else "Hide", color = TextDim)
        }
    }
}

@Composable
private fun RenameErrorSlot(message: String?) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 24.dp)
            .padding(horizontal = 20.dp),
    ) {
        message?.let {
            Text(
                text = it,
                color = Red,
                style = MaterialTheme.typography.labelSmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            )
        }
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
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(title, style = MaterialTheme.typography.titleMedium)
        Text(
            text = detail,
            color = TextDim,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.padding(top = 8.dp),
        )
    }
}

@Composable
private fun FullPageFailure(message: String, onRetry: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text("Could not load", style = MaterialTheme.typography.titleMedium)
        Text(
            text = message,
            color = TextDim,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.padding(top = 8.dp, bottom = 20.dp),
        )
        OutlinedButton(
            onClick = onRetry,
            modifier = Modifier.heightIn(min = 48.dp),
        ) {
            Text("Retry")
        }
    }
}

private fun formatTimestamp(updatedAt: Long): String =
    DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(updatedAt))
