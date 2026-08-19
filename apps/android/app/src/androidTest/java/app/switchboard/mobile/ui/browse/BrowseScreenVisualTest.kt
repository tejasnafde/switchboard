package app.switchboard.mobile.ui.browse

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import app.switchboard.mobile.data.local.OfflineSnapshot
import app.switchboard.mobile.domain.remote.Project
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.ui.theme.SwitchboardTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class BrowseScreenVisualTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun projectListUsesCompactIdentityRowsWithoutRedundantShowActions() {
        var opened: String? = null
        compose.setContent {
            SwitchboardTheme {
                BrowseScreen(
                    state = state(project("/work/switchboard", "switchboard")),
                    route = BrowseRoute.Projects,
                    onProjectTap = { opened = it.path },
                    onSessionTap = {},
                    onRetry = {},
                    onBack = {},
                )
            }
        }

        compose.onNodeWithText("SW", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText("switchboard", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithContentDescription("switchboard, 0 sessions").performClick()
        compose.onNodeWithText("Show").assertDoesNotExist()
        compose.onNodeWithText("Hide").assertDoesNotExist()
        compose.runOnIdle { assertEquals("/work/switchboard", opened) }
    }

    private fun state(project: Project) = BrowseState(
        connectionId = "machine-1",
        connectionLabel = "Tejas's MacBook",
        offlineSnapshot = OfflineSnapshot(
            connections = emptyList(),
            credentialRefs = emptyList(),
            nativeCredentialRefs = emptyList(),
            preferences = emptyList(),
            threadPreferences = emptyList(),
            collapsedWorkspaces = emptyList(),
            cachedThreads = emptyList(),
            feedRows = emptyList(),
            outbox = emptyList(),
            outboxAttachments = emptyList(),
            replayStates = emptyList(),
            pendingControlActions = emptyList(),
            quarantinedRecords = emptyList(),
        ),
        projects = BrowseLoadState.Ready(listOf(BrowseProjectRecord(project))),
    )

    private fun project(path: String, name: String) = Project(
        path = path,
        name = name,
        sessions = emptyList(),
        workspaceId = null,
        raw = JsonObject(linkedMapOf()),
    )
}
