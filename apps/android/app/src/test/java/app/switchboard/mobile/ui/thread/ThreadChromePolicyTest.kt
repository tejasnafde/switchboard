package app.switchboard.mobile.ui.thread

import app.switchboard.mobile.domain.thread.FeedItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ThreadChromePolicyTest {
    @Test
    fun `archive is available only when the provider is safely inactive`() {
        assertTrue(ThreadArchivePolicy.canArchive("idle", archiving = false))
        assertTrue(ThreadArchivePolicy.canArchive("ready", archiving = false))
        assertFalse(ThreadArchivePolicy.canArchive("running", archiving = false))
        assertFalse(ThreadArchivePolicy.canArchive("connecting", archiving = false))
        assertFalse(ThreadArchivePolicy.canArchive("retrying", archiving = false))
        assertFalse(ThreadArchivePolicy.canArchive("idle", archiving = true))
    }

    @Test
    fun `subtitle names the provider and state but not the model`() {
        assertEquals(
            "Codex · Working",
            ThreadChromePolicy.subtitle(
                metadata(
                    status = "running",
                    provider = "codex",
                    model = "gpt-5",
                ),
            ),
        )
        assertEquals(
            "Saved locally",
            ThreadChromePolicy.subtitle(metadata(status = "cached")),
        )
    }

    @Test
    fun `metadata summary includes measured values and omits missing ones`() {
        assertEquals(
            listOf("1,500 of 2,000 tokens", "$0.42", "last turn 1.3s"),
            ThreadChromePolicy.metadataSummary(
                metadata(
                    contextLabel = "1,500 / 2,000 tokens",
                    costLabel = "$0.42",
                    durationLabel = "1.3s",
                ),
            ),
        )
        assertEquals(emptyList<String>(), ThreadChromePolicy.metadataSummary(metadata()))
    }

    @Test
    fun `usage line joins the measured values into one sentence`() {
        assertEquals(
            "576,511 of 1,000,000 tokens · $904.67 · last turn 1.3s",
            ThreadChromePolicy.usageLine(
                metadata(
                    contextLabel = "576511 / 1000000 tokens",
                    costLabel = "$904.67",
                    durationLabel = "1.3s",
                ),
            ),
        )
        assertEquals("$0.42", ThreadChromePolicy.usageLine(metadata(costLabel = "$0.42")))
        assertNull(ThreadChromePolicy.usageLine(metadata()))
    }

    @Test
    fun `turn duration shows from 30 seconds`() {
        assertFalse(ThreadChromePolicy.showsTurnDuration(null))
        assertFalse(ThreadChromePolicy.showsTurnDuration(1_300))
        assertFalse(ThreadChromePolicy.showsTurnDuration(29_999))
        assertTrue(ThreadChromePolicy.showsTurnDuration(30_000))
        assertTrue(ThreadChromePolicy.showsTurnDuration(95_000))
    }

    @Test
    fun `latest pending approval owns the composer slot`() {
        val resolved = FeedItem.Approval("old", "old-request", "Read", "README", "tool", "approved")
        val pending = FeedItem.Approval("pending", "request", "Bash", "npm test", "tool", "pending")
        val rows = listOf(
            ThreadPresenter.row(resolved),
            ThreadPresenter.row(pending),
            ThreadPresenter.row(FeedItem.Text("text", "message", "Waiting", "assistant")),
        )

        assertEquals("pending", ThreadChromePolicy.pendingApproval(rows)?.key)
        assertEquals(listOf("old", "text"), ThreadChromePolicy.feedRows(rows).map { it.key })
        assertNull(ThreadChromePolicy.pendingApproval(listOf(ThreadPresenter.row(resolved))))
    }

    private fun metadata(
        status: String = "idle",
        provider: String? = null,
        model: String? = null,
        contextLabel: String? = null,
        costLabel: String? = null,
        durationLabel: String? = null,
    ) = ThreadMetadataPresentation(
        status = status,
        runtimeMode = "sandbox",
        provider = provider,
        instanceName = null,
        model = model,
        contextLabel = contextLabel,
        contextFraction = null,
        costLabel = costLabel,
        durationLabel = durationLabel,
        unread = 0,
    )
}
