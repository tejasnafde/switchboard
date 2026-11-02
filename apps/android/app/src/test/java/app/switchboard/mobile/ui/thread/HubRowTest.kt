package app.switchboard.mobile.ui.thread

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import app.switchboard.mobile.data.thread.ThreadHubState
import app.switchboard.mobile.domain.thread.ChildState
import app.switchboard.mobile.domain.thread.HubChatRef
import app.switchboard.mobile.domain.thread.HubChatView
import app.switchboard.mobile.domain.thread.HubChildPhase
import app.switchboard.mobile.domain.thread.HubChildView
import app.switchboard.mobile.domain.thread.HubRemoteChild
import app.switchboard.mobile.domain.thread.HubWake
import app.switchboard.mobile.domain.thread.ParentState
import app.switchboard.mobile.ui.theme.SwitchboardTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The Hub row: the chip, the children list with Open and Stop, Stop all, and a remote child's report. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class HubRowTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private fun ref(id: String, title: String = id) = HubChatRef(id, listOf(id), title, "codex", "/p", 0)

    private val local = HubChildView(
        chat = ref("c1", "Fix login"),
        liveId = "live-c1",
        phase = HubChildPhase.Open,
        state = ChildState.Working,
        lastWake = HubWake("report", "Tests pass"),
    )
    private val remote = HubChildView(
        chat = ref("c2", "Port docs"),
        liveId = null,
        phase = HubChildPhase.Open,
        state = ChildState.ResultReady,
        lastWake = HubWake("report", "Opened the PR"),
        remote = HubRemoteChild("vm-1", "build-vm", connected = true, ageMs = 0, stopping = false),
    )
    private val view = HubChatView(ref("p1"), null, listOf(local, remote), ParentState.Waiting)

    @Test
    fun rendersNothingWithoutTheCapability() {
        compose.setContent { SwitchboardTheme { HubRow(ThreadHubState(view = view), {}, {}, {}, {}) } }
        compose.onNodeWithTag(ThreadTestTags.HUB_ROW).assertDoesNotExist()
    }

    @Test
    fun showsTheChipAndOnExpandTheChildrenWithTheirActions() {
        val stopped = mutableListOf<String>()
        val opened = mutableListOf<String>()
        var stopAll = 0
        compose.setContent {
            SwitchboardTheme {
                HubRow(
                    ThreadHubState(available = true, remoteAvailable = true, view = view, expanded = true),
                    onToggle = {},
                    onStop = { stopped += it },
                    onStopAll = { stopAll++ },
                    onOpen = { opened += it.id },
                )
            }
        }
        compose.onNodeWithText("Hub · 2 children on 2 machines · Waiting for children").assertExists()
        compose.onNodeWithText("Working: Tests pass").assertExists()
        compose.onNodeWithText("build-vm").assertExists()
        compose.onNodeWithTag(ThreadTestTags.HUB_STOP_ALL).performClick()
        assertEquals(1, stopAll)
        compose.onNodeWithText("Stop").performClick()
        assertEquals(listOf("c1"), stopped)

        openOf("c1").performClick()
        assertEquals(listOf("c1"), opened)
        openOf("c2").performClick()
        assertEquals(listOf("c1"), opened)
        compose.onNodeWithText("Opened the PR").assertExists()
        compose.onNodeWithText("Read on the desktop.").assertExists()
    }

    @Test
    fun aCollapsedRowShowsOnlyTheChip() {
        compose.setContent {
            SwitchboardTheme { HubRow(ThreadHubState(available = true, view = view.withoutRemote()), {}, {}, {}, {}) }
        }
        compose.onNodeWithText("Hub · 2 children · Waiting for children").assertExists()
        compose.onNodeWithTag(ThreadTestTags.hubChild("c1")).assertDoesNotExist()
        compose.onNodeWithTag(ThreadTestTags.HUB_STOP_ALL).assertDoesNotExist()
    }

    @Test
    fun withoutTheRemoteCapabilityARemoteChildHidesItsMachineButNeverOpensAnEmptyChat() {
        val opened = mutableListOf<String>()
        val unknown = local.copy(chat = ref("c3", "Future"), state = ChildState.Unknown, lastWake = null)
        compose.setContent {
            SwitchboardTheme {
                HubRow(
                    ThreadHubState(available = true, view = view.copy(children = view.children + unknown), expanded = true),
                    onToggle = {},
                    onStop = {},
                    onStopAll = {},
                    onOpen = { opened += it.id },
                )
            }
        }
        compose.onNodeWithText("Hub · 3 children · Waiting for children").assertExists()
        compose.onNodeWithText("Unknown state").assertExists()
        compose.onNodeWithText("build-vm").assertDoesNotExist()
        openOf("c2").performClick()
        assertEquals(emptyList<String>(), opened)
        compose.onNodeWithText("Read on the desktop.").assertExists()
        compose.onNodeWithText("build-vm").assertDoesNotExist()
    }

    private fun openOf(childId: String) =
        compose.onNode(hasText("Open") and hasAnyAncestor(hasTestTag(ThreadTestTags.hubChild(childId))))
}
