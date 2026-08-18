package app.switchboard.mobile.ui.browse

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
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
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.fillMaxSize()) {
        when (route) {
            BrowseRoute.Projects -> {
                BrowseTopBar(title = state.connectionLabel, onBack = onBack)
                ProjectsSurface(
                    presentation = BrowsePresenter.projects(state.projects),
                    onProjectTap = { row ->
                        onProjectTap(row.project)
                    },
                    onRetry = { onRetry(BrowseRequest.Projects) },
                )
            }

            is BrowseRoute.Conversations -> {
                BrowseTopBar(title = route.projectName, onBack = onBack)
                ConversationsSurface(
                    presentation = BrowsePresenter.conversations(
                        state = state.conversationsByProject[route.projectPath]
                            ?: BrowseLoadState.Loading(),
                        offlineIndex = OfflineBrowseIndex.from(
                            state.offlineSnapshot,
                            state.connectionId,
                        ),
                    ),
                    projectName = route.projectName,
                    onSessionTap = { onSessionTap(it.conversation) },
                    onRetry = { onRetry(BrowseRequest.Conversations(route.projectPath)) },
                )
            }
        }
    }
}

@Composable
private fun BrowseTopBar(title: String, onBack: () -> Unit) {
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
                .padding(start = 8.dp, end = 16.dp),
        )
    }
}

@Composable
private fun ProjectsSurface(
    presentation: BrowseProjectsPresentation,
    onProjectTap: (BrowseProjectRow) -> Unit,
    onRetry: () -> Unit,
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

        is BrowseProjectsPresentation.Content -> LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(bottom = 24.dp),
        ) {
            item { BrowseStatusRow(presentation.status, onRetry) }
            items(presentation.rows, key = BrowseProjectRow::path) { row ->
                ProjectRow(row = row, onClick = { onProjectTap(row) })
            }
            item { Spacer(Modifier.navigationBarsPadding()) }
        }
    }
}

@Composable
private fun ConversationsSurface(
    presentation: BrowseConversationsPresentation,
    projectName: String,
    onSessionTap: (BrowseConversationRow) -> Unit,
    onRetry: () -> Unit,
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

        is BrowseConversationsPresentation.Content -> LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(bottom = 24.dp),
        ) {
            item { BrowseStatusRow(presentation.status, onRetry) }
            items(presentation.rows, key = BrowseConversationRow::id) { row ->
                ConversationRow(row = row, onClick = { onSessionTap(row) })
            }
            item { Spacer(Modifier.navigationBarsPadding()) }
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
            .padding(start = 20.dp, end = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (status.showProgress) {
            CircularProgressIndicator(
                color = color,
                strokeWidth = 2.dp,
                modifier = Modifier.size(16.dp),
            )
            Spacer(Modifier.width(10.dp))
        }
        Column(modifier = Modifier.weight(1f)) {
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
    BrowsePressableRow(onClick = onClick) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = row.name,
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = "${row.sessionCount} ${if (row.sessionCount == 1) "session" else "sessions"}",
                color = TextDim,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(top = 2.dp),
            )
            Text(
                text = row.path,
                color = TextDim,
                fontFamily = GeistMono,
                fontSize = 11.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 2.dp),
            )
        }
        Text("›", color = TextDim, fontSize = 22.sp)
    }
}

@Composable
private fun ConversationRow(row: BrowseConversationRow, onClick: () -> Unit) {
    BrowsePressableRow(onClick = onClick) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = row.title,
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(top = 7.dp),
            ) {
                AgentTag(row.agentType)
                Text(
                    text = remember(row.updatedAt) { formatTimestamp(row.updatedAt) },
                    color = TextDim,
                    style = MaterialTheme.typography.labelSmall,
                    modifier = Modifier.padding(start = 10.dp),
                )
                if (row.availableOffline) {
                    Text(
                        text = "saved",
                        color = Accent,
                        style = MaterialTheme.typography.labelSmall,
                        modifier = Modifier.padding(start = 10.dp),
                    )
                }
            }
        }
        Text("›", color = TextDim, fontSize = 22.sp)
    }
}

@Composable
private fun AgentTag(agentType: String) {
    val label = when (agentType) {
        "claude", "claude-code" -> "CLAUDE"
        "codex" -> "CODEX"
        "opencode" -> "OPENCODE"
        else -> agentType.uppercase()
    }
    Text(
        text = label,
        color = TextDim,
        fontFamily = GeistMono,
        fontSize = 10.sp,
        modifier = Modifier
            .clip(RoundedCornerShape(5.dp))
            .background(SurfaceRaised)
            .padding(horizontal = 6.dp, vertical = 2.dp),
    )
}

@Composable
private fun BrowsePressableRow(
    onClick: () -> Unit,
    content: @Composable RowScope.() -> Unit,
) {
    val interactionSource = remember { MutableInteractionSource() }
    val pressed by interactionSource.collectIsPressedAsState()
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 72.dp)
            .background(if (pressed) SurfaceRaised else Surface)
            .clickable(
                interactionSource = interactionSource,
                indication = null,
                role = Role.Button,
                onClick = onClick,
            )
            .padding(horizontal = 20.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        content = content,
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
