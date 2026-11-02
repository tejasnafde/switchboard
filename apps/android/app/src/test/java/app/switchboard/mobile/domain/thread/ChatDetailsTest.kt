package app.switchboard.mobile.domain.thread

import app.switchboard.mobile.domain.reviews.ChecksRollup
import app.switchboard.mobile.domain.reviews.PrApprovals
import app.switchboard.mobile.domain.reviews.PrListData
import app.switchboard.mobile.domain.reviews.PrPerson
import app.switchboard.mobile.domain.reviews.PrRef
import app.switchboard.mobile.domain.reviews.PrSummary
import app.switchboard.mobile.domain.reviews.PrViewer
import app.switchboard.mobile.ui.theme.Green
import app.switchboard.mobile.ui.theme.Red
import app.switchboard.mobile.ui.theme.TextPrimary
import app.switchboard.mobile.ui.thread.DETAILS_SURFACE
import app.switchboard.mobile.ui.thread.LEFT_COLOUR
import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.pow

/** `ChatDetails` and `UsageLeft`: ports of the desktop's chat-details-model.ts and src/shared/usage-left.ts. */
class ChatDetailsTest {
    @Test
    fun `percent left is clamped and rounded half up, null when unknown`() {
        assertEquals(58, UsageLeft.percent(42.4))
        assertEquals(59, UsageLeft.percent(41.5))
        assertEquals(0, UsageLeft.percent(130.0))
        assertEquals(100, UsageLeft.percent(-5.0))
        assertNull(UsageLeft.percent(null))
        assertNull(UsageLeft.percent(Double.NaN))
    }

    @Test
    fun `tone turns error at 10 left and warning at 20 left`() {
        assertEquals(LeftTone.Error, UsageLeft.tone(10))
        assertEquals(LeftTone.Warning, UsageLeft.tone(11))
        assertEquals(LeftTone.Warning, UsageLeft.tone(20))
        assertEquals(LeftTone.Neutral, UsageLeft.tone(21))
        assertEquals(LeftTone.Neutral, UsageLeft.tone(null))
    }

    @Test
    fun `branch shows the name, a detached HEAD, None and an ellipsis`() {
        assertEquals(DetailsValue("feat/x"), ChatDetails.branch(DetailsRead.Read(BranchName("feat/x"))))
        assertEquals(DetailsValue("Detached HEAD"), ChatDetails.branch(DetailsRead.Read(BranchName(null))))
        assertEquals(DetailsValue("None", muted = true), ChatDetails.branch(DetailsRead.Failed))
        assertEquals(DetailsValue("…", muted = true), ChatDetails.branch(DetailsRead.Reading))
    }

    @Test
    fun `changes show lines added and removed, and No changes at zero`() {
        assertEquals(ChangesValue.Lines(12, 3), ChatDetails.changes(DetailsRead.Read(DiffStat(12, 3))))
        assertEquals(
            ChangesValue.Text(DetailsValue("No changes", muted = true)),
            ChatDetails.changes(DetailsRead.Read(DiffStat(0, 0))),
        )
        assertEquals(ChangesValue.Text(DetailsValue("None", muted = true)), ChatDetails.changes(DetailsRead.Failed))
    }

    @Test
    fun `the first open PR wins over a newer merged one, with failing checks marked bad`() {
        val pr = ChatDetails.pr(
            listOf(link(7, 50, "merged"), link(5, 10)),
            list(summary(5, ChecksRollup("failure", 3, 1, 2, 0))),
        )
        assertEquals(PrValue("PR 5", listOf(PrPart("#5"), PrPart("2 checks failed", bad = true))), pr)
    }

    @Test
    fun `without the Reviews list the newest link shows its stored state and repository`() {
        assertEquals(
            PrValue("acme/app", listOf(PrPart("#4"), PrPart("merged"))),
            ChatDetails.pr(listOf(link(3, 10, "closed"), link(4, 20, "merged")), null),
        )
        assertNull(ChatDetails.pr(emptyList(), null))
        assertEquals(
            PrPart("1 check failed", bad = true),
            ChatDetails.pr(listOf(link(5, 1)), list(summary(5, ChecksRollup("failure", 1, 0, 1, 0))))?.detail?.get(1),
        )
        assertEquals(
            PrPart("checks running"),
            ChatDetails.pr(listOf(link(5, 1)), list(summary(5, ChecksRollup("pending", 1, 0, 0, 1))))?.detail?.get(1),
        )
    }

    @Test
    fun `bars show percent left with tones, Unavailable and reading`() {
        val (weekly, session, context) = ChatDetails.usageBars(UsageLimits(85.0, 91.0), reading = false, contextUsed = 40.0)
        assertEquals(UsageBar("Weekly", 85, 15, LeftTone.Warning, pending = false), weekly)
        assertEquals(UsageBar("5-hour session", 91, 9, LeftTone.Error, pending = false), session)
        assertEquals(UsageBar("Context", 40, 60, LeftTone.Neutral, pending = false), context)

        assertEquals(
            listOf("Weekly, unavailable", "5-hour session, unavailable", "Context, unavailable"),
            ChatDetails.usageBars(null, reading = false, contextUsed = null).map(ChatDetails::barDescription),
        )
        assertEquals(
            listOf(true, true, false),
            ChatDetails.usageBars(null, reading = true, contextUsed = null).map { it.pending },
        )
    }

    @Test
    fun `a chat with no profile reads its agent's seed account`() {
        assertEquals("claude-code-default", ChatDetails.defaultInstanceId("claude"))
        assertEquals("claude-code-default", ChatDetails.defaultInstanceId(null))
        assertEquals("codex-default", ChatDetails.defaultInstanceId("codex"))
    }

    @Test
    fun `the sheet's text colours read at 4_5 to 1 or better on its surface`() {
        // The app has one dark theme.
        (listOf(TextPrimary, Green, Red) + LEFT_COLOUR.values).forEach { colour ->
            assertTrue("$colour", contrast(colour, DETAILS_SURFACE) >= 4.5)
        }
    }

    private fun luminance(colour: Color): Double {
        fun channel(c: Float): Double = if (c <= 0.04045f) c / 12.92 else ((c + 0.055) / 1.055).pow(2.4)
        return 0.2126 * channel(colour.red) + 0.7152 * channel(colour.green) + 0.0722 * channel(colour.blue)
    }

    private fun contrast(a: Color, b: Color): Double {
        val (light, dark) = listOf(luminance(a), luminance(b)).sortedDescending()
        return (light + 0.05) / (dark + 0.05)
    }

    private fun link(number: Long, linkedAt: Long, state: String? = null) =
        PrLink(PrLinkRef("github", "acme", "app", number), "auto", linkedAt, state)

    private fun list(vararg prs: PrSummary) =
        PrListData(prs = prs.toList(), sources = emptyList(), fetchedAt = 10, hidden = emptyList(), hiddenRepos = emptyList())

    private fun summary(number: Long, checks: ChecksRollup) = PrSummary(
        ref = PrRef("github", "acme", "app", number),
        title = "PR $number",
        url = "",
        author = PrPerson("tejas", "tejas", null),
        state = "open",
        draft = false,
        sourceBranch = "b$number",
        targetBranch = "main",
        headFromFork = false,
        createdAt = 0,
        updatedAt = 0,
        mergedAt = null,
        additions = null,
        deletions = null,
        changedFiles = null,
        unresolvedConversations = 0,
        mergeConflicts = false,
        conflictedFiles = emptyList(),
        checks = checks,
        reviewers = emptyList(),
        approvals = PrApprovals(0, null),
        viewer = PrViewer(isAuthor = true, isRequestedReviewer = false, hasReviewed = false, hasCommented = false),
        projectPaths = emptyList(),
    )
}
