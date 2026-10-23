package app.switchboard.mobile.ui.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import app.switchboard.mobile.ui.theme.SwitchboardDimensions

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SwitchboardScaffold(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    /** Makes the title block a button, for example to show the thread's usage. */
    onTitleClick: (() -> Unit)? = null,
    titleClickLabel: String? = null,
    navigationIcon: @Composable () -> Unit = {},
    actions: @Composable RowScope.() -> Unit = {},
    snackbarHostState: SnackbarHostState? = null,
    bottomBar: @Composable () -> Unit = {},
    content: @Composable (PaddingValues) -> Unit,
) {
    Scaffold(
        modifier = modifier,
        containerColor = MaterialTheme.colorScheme.background,
        contentColor = MaterialTheme.colorScheme.onBackground,
        topBar = {
            TopAppBar(
                title = {
                    Column(
                        modifier = if (onTitleClick != null) {
                            Modifier
                                .heightIn(min = SwitchboardDimensions.minimumTouchTarget)
                                .clickable(role = Role.Button, onClickLabel = titleClickLabel, onClick = onTitleClick)
                        } else {
                            Modifier
                        },
                        verticalArrangement = Arrangement.Center,
                    ) {
                        Text(
                            text = title,
                            modifier = Modifier.semantics { heading() },
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            style = MaterialTheme.typography.titleLarge,
                        )
                        subtitle?.let {
                            Text(
                                text = it,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                    }
                },
                navigationIcon = navigationIcon,
                actions = actions,
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.background,
                    scrolledContainerColor = MaterialTheme.colorScheme.surface,
                ),
            )
        },
        snackbarHost = {
            snackbarHostState?.let { SnackbarHost(hostState = it) }
        },
        bottomBar = bottomBar,
        content = content,
    )
}

@Composable
fun SwitchboardTopBarAction(
    contentDescription: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    IconButton(
        onClick = onClick,
        modifier = modifier
            .size(SwitchboardDimensions.minimumTouchTarget)
            .semantics { this.contentDescription = contentDescription },
        content = content,
    )
}
