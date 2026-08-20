package app.switchboard.mobile.ui.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.switchboard.mobile.ui.components.SectionLabel
import app.switchboard.mobile.ui.theme.TextDim

@Composable
fun SettingsScreen(
    presentation: SettingsPresentation,
    onBack: () -> Unit,
    onGoogleAccount: () -> Unit,
    onManageMachines: () -> Unit,
    onUpdateAction: (app.switchboard.mobile.update.UpdateAction) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.fillMaxSize()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .statusBarsPadding()
                .heightIn(min = 56.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack, modifier = Modifier.size(48.dp)) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
            }
            Text(
                text = "Settings",
                style = MaterialTheme.typography.headlineLarge,
                modifier = Modifier.semantics { heading() },
            )
        }
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(
                start = 20.dp,
                end = 20.dp,
                bottom = 120.dp,
            ),
        ) {
            item { SectionLabel("ACCOUNT", Modifier.padding(top = 24.dp, bottom = 8.dp)) }
            item {
                SettingsNavigationRow(
                    title = "Google account",
                    detail = presentation.accountDetail,
                    onClick = onGoogleAccount,
                )
            }
            item { HorizontalDivider() }

            item { SectionLabel("CONNECTIONS", Modifier.padding(top = 24.dp, bottom = 8.dp)) }
            item {
                SettingsNavigationRow(
                    title = "Machines",
                    detail = presentation.machinesDetail,
                    onClick = onManageMachines,
                )
            }
            item { HorizontalDivider() }

            item { SectionLabel("APP", Modifier.padding(top = 24.dp, bottom = 8.dp)) }
            item {
                ListItem(
                    headlineContent = { Text("Updates") },
                    supportingContent = {
                        Text(
                            text = presentation.update.detail,
                            color = TextDim,
                            maxLines = 2,
                        )
                    },
                    trailingContent = {
                        when {
                            presentation.update.action != null -> TextButton(
                                onClick = {
                                    onUpdateAction(requireNotNull(presentation.update.action))
                                },
                                modifier = Modifier.heightIn(min = 48.dp),
                            ) {
                                Text(requireNotNull(presentation.update.actionLabel))
                            }
                            presentation.update.busy -> CircularProgressIndicator(
                                modifier = Modifier.size(20.dp),
                                strokeWidth = 2.dp,
                            )
                        }
                    },
                )
            }
            item { HorizontalDivider() }
            item {
                ListItem(
                    headlineContent = { Text("Switchboard") },
                    supportingContent = {
                        Text(presentation.versionDetail, color = TextDim)
                    },
                )
            }
        }
    }
}

@Composable
private fun SettingsNavigationRow(
    title: String,
    detail: String,
    onClick: () -> Unit,
) {
    ListItem(
        headlineContent = { Text(title) },
        supportingContent = { Text(detail, color = TextDim, maxLines = 2) },
        trailingContent = { Text("Open", color = MaterialTheme.colorScheme.primary) },
        modifier = Modifier.clickable(role = Role.Button, onClick = onClick),
    )
}
