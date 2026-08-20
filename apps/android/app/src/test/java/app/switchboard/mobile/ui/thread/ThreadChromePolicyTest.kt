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
    fun `subtitle describes only known provider model and state`() {
        assertEquals(
            "Codex · gpt-5 · Working",
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
            listOf("1,500 / 2,000 tokens", "$0.42", "1.3s"),
            ThreadChromePolicy.metadataSummary(
                metadata(
                    contextLabel = "1500 / 2000 tokens",
                    costLabel = "$0.42",
                    durationLabel = "1.3s",
                ),
            ),
        )
        assertEquals(emptyList<String>(), ThreadChromePolicy.metadataSummary(metadata()))
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
