package app.switchboard.mobile.ui.thread

import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import app.switchboard.mobile.domain.thread.FeedItem
import app.switchboard.mobile.domain.thread.SecretRequestCards
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.ui.theme.SwitchboardTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The read-only secret card: no input of any kind, and Decline is a deny with no response. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SecretRequestRowTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private val card = SecretRequestCards.decode(
        JsonObject(
            linkedMapOf(
                "name" to JsonString("TAILSCALE_AUTHKEY"),
                "title" to JsonString("Tailscale auth key for test VMs"),
                "instructions" to JsonString("Create it at https://login.tailscale.com/admin/settings/keys."),
                "ttl" to JsonString("24h"),
            ),
        ),
    )!!

    private fun item(state: String, id: String = "sbsec_1") = FeedItem.Approval(
        "a-$id", id, "request_secret", "An agent asks for a secret.", "tool", state, secretRequest = card,
    )

    @Test
    fun showsTheCardWithNoInputAndDeclinesWithADeny() {
        val actions = mutableListOf<ThreadUiAction>()
        compose.setContent { SwitchboardTheme { SecretRequestRow(item("pending"), card, null) { actions += it } } }

        compose.onNodeWithText(SecretRequestCards.HEADER).assertExists()
        compose.onNodeWithText("Tailscale auth key for test VMs").assertExists()
        compose.onNodeWithText("login.tailscale.com/admin/settings/keys", substring = true).assertExists()
        compose.onNodeWithText(SecretRequestCards.ANSWER_ON_COMPUTER).assertExists()
        compose.onNodeWithText("Approve").assertDoesNotExist()
        assertEquals(0, compose.onAllNodes(SemanticsMatcher.keyIsDefined(SemanticsActions.SetText)).fetchSemanticsNodes().size)

        compose.onNodeWithTag(ThreadTestTags.SECRET_DECLINE).performClick()
        assertEquals(listOf(ThreadUiAction.Approval("sbsec_1", ThreadApprovalDecision.DENY, null)), actions)
    }

    @Test
    fun isOneLineOnceAnswered() {
        compose.setContent { SwitchboardTheme { SecretRequestRow(item("approve"), card, null) {} } }
        compose.onNodeWithText("Saved TAILSCALE_AUTHKEY").assertExists()
        compose.onNodeWithTag(ThreadTestTags.SECRET_DECLINE).assertDoesNotExist()
    }

    @Test
    fun aDenyThisPhoneDidNotSendReadsClosedNotDeclined() {
        // Its own id: the declined set is process-wide and other tests decline sbsec_1.
        compose.setContent { SwitchboardTheme { SecretRequestRow(item("deny", "sbsec_never_declined"), card, null) {} } }
        compose.onNodeWithText("TAILSCALE_AUTHKEY closed").assertExists()
        compose.onNodeWithText("Declined TAILSCALE_AUTHKEY").assertDoesNotExist()
    }

    @Test
    fun aDeclineFromThisPhoneReadsDeclined() {
        var state by mutableStateOf("pending")
        compose.setContent { SwitchboardTheme { SecretRequestRow(item(state), card, null) {} } }
        compose.onNodeWithTag(ThreadTestTags.SECRET_DECLINE).performClick()
        state = "deny"
        compose.onNodeWithText("Declined TAILSCALE_AUTHKEY").assertExists()
    }
}
