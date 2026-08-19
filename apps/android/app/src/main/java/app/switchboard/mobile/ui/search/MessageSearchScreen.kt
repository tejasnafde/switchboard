package app.switchboard.mobile.ui.search

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.switchboard.mobile.data.remote.MessageSearchCoordinator
import app.switchboard.mobile.data.remote.MessageSearchScheduler
import app.switchboard.mobile.data.remote.MessageSearchState
import app.switchboard.mobile.data.remote.ReadyClientLease
import app.switchboard.mobile.domain.remote.MessageSearchResult
import app.switchboard.mobile.platform.protocol.Cancelable
import app.switchboard.mobile.ui.components.SwitchboardEmptyState
import app.switchboard.mobile.ui.components.SwitchboardListRow
import app.switchboard.mobile.ui.components.SwitchboardScaffold
import app.switchboard.mobile.ui.theme.SurfaceRaised
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
fun MessageSearchRouteHost(
    connectionLabel: String,
    lease: ReadyClientLease,
    onBack: () -> Unit,
    onOpenResult: (MessageSearchResult) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val coordinator = remember(lease.scope, lease.client) {
        MessageSearchCoordinator(
            connectionId = lease.scope.connectionId,
            expectedGeneration = lease.scope.generation,
            remote = lease.client,
            scheduler = MessageSearchScheduler { delayMillis, action ->
                val job = scope.launch {
                    delay(delayMillis)
                    action()
                }
                Cancelable(job::cancel)
            },
        )
    }
    DisposableEffect(coordinator) {
        onDispose(coordinator::close)
    }
    val state by coordinator.state.collectAsState()
    MessageSearchScreen(
        connectionLabel = connectionLabel,
        state = state,
        onQueryChange = coordinator::updateQuery,
        onRetry = coordinator::retry,
        onBack = onBack,
        onOpenResult = onOpenResult,
    )
}

@Composable
fun MessageSearchScreen(
    connectionLabel: String,
    state: MessageSearchState,
    onQueryChange: (String) -> Unit,
    onRetry: () -> Unit,
    onBack: () -> Unit,
    onOpenResult: (MessageSearchResult) -> Unit,
    modifier: Modifier = Modifier,
) {
    SwitchboardScaffold(
        title = "Search chats",
        subtitle = connectionLabel,
        modifier = modifier,
        navigationIcon = {
            IconButton(
                onClick = onBack,
                modifier = Modifier.semantics { contentDescription = "Back" },
            ) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = null)
            }
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            MessageSearchField(
                value = state.query,
                loading = state.loading,
                onValueChange = onQueryChange,
            )
            when {
                state.error != null -> SearchStateSlot {
                    SwitchboardEmptyState(
                        title = "Search unavailable",
                        body = state.error,
                        actionLabel = "Retry",
                        onAction = onRetry,
                    )
                }

                state.query.trim().length < 2 -> SearchStateSlot {
                    SwitchboardEmptyState(
                        title = "Search every chat",
                        body = "Enter at least two characters to search messages on this machine.",
                    )
                }

                state.searched && !state.loading && state.results.isEmpty() -> SearchStateSlot {
                    SwitchboardEmptyState(
                        title = "No matches",
                        body = "No saved message contains “${state.query.trim()}”.",
                    )
                }

                else -> {
                    val rows = remember(state.results) { state.results.map(MessageSearchPresenter::row) }
                    LazyColumn(modifier = Modifier.fillMaxSize()) {
                        items(
                            items = rows,
                            key = { "${it.result.conversationId}:${it.result.messageId}" },
                        ) { row ->
                            SwitchboardListRow(
                                title = row.title,
                                supportingText = listOf(row.snippet, row.metadata)
                                    .filter(String::isNotBlank)
                                    .joinToString("\n"),
                                onClick = { onOpenResult(row.result) },
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun MessageSearchField(
    value: String,
    loading: Boolean,
    onValueChange: (String) -> Unit,
) {
    val focusRequester = remember { FocusRequester() }
    LaunchedEffect(Unit) { focusRequester.requestFocus() }
    TextField(
        value = value,
        onValueChange = onValueChange,
        placeholder = { Text("Search messages") },
        leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
        trailingIcon = when {
            loading -> {
                {
                    CircularProgressIndicator(
                        modifier = Modifier.padding(12.dp),
                        strokeWidth = 2.dp,
                    )
                }
            }

            value.isNotEmpty() -> {
                {
                    IconButton(onClick = { onValueChange("") }) {
                        Icon(Icons.Default.Close, contentDescription = "Clear search")
                    }
                }
            }

            else -> null
        },
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
            .focusRequester(focusRequester)
            .semantics { contentDescription = "Search messages" },
    )
}

@Composable
private fun SearchStateSlot(content: @Composable () -> Unit) {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        content()
    }
}
