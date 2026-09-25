package app.switchboard.mobile.domain.thread

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The cases of tests/unit/turn-preview.test.ts, one for one. */
class TurnPreviewTest {
    private fun user(text: String) = PreviewMessage(text, isAssistant = false, isUser = true)
    private fun assistant(text: String) = PreviewMessage(text, isAssistant = true, isUser = false)

    @Test
    fun returnsNullForNoMessages() {
        assertNull(TurnPreview.turnPreviewLine(emptyList()))
    }

    @Test
    fun returnsNullWhenThereIsNoAssistantMessageYet() {
        assertNull(TurnPreview.turnPreviewLine(listOf(user("do the thing"))))
    }

    @Test
    fun returnsTheDigestFromTheNewestAssistantMessage() {
        assertEquals(
            "Reading files",
            TurnPreview.turnPreviewLine(listOf(user("start"), assistant("<agent_digest>Reading files</agent_digest>"))),
        )
    }

    @Test
    fun findsADigestInAnEarlierAssistantMessageOfTheSameTurn() {
        val messages = listOf(
            user("start"),
            assistant("<agent_digest>Reading files</agent_digest> then I will run the tests"),
            assistant("Now running the test suite..."),
        )
        assertEquals("Reading files", TurnPreview.turnPreviewLine(messages))
    }

    @Test
    fun prefersTheNewestDigestWhenSeveralMessagesReportOne() {
        val messages = listOf(
            user("start"),
            assistant("<agent_digest>Step one</agent_digest>"),
            assistant("<agent_digest>Step two</agent_digest>"),
        )
        assertEquals("Step two", TurnPreview.turnPreviewLine(messages))
    }

    @Test
    fun fallsBackToTheNewestAssistantMessageWhenTheTurnHasNoDigest() {
        val messages = listOf(user("start"), assistant("Reading the config file now"), assistant("Now running the test suite"))
        assertEquals("Now running the test suite", TurnPreview.turnPreviewLine(messages))
    }

    @Test
    fun doesNotLeakADigestFromAPreviousTurn() {
        val messages = listOf(
            user("first task"),
            assistant("<agent_digest>Old digest, done</agent_digest>"),
            user("second task"),
            assistant("Working on the second task now"),
        )
        assertEquals("Working on the second task now", TurnPreview.turnPreviewLine(messages))
    }

    @Test
    fun doesNotUseRawTextFromAPreviousTurnOnceANewOneStarted() {
        val messages = listOf(
            user("first task"),
            assistant("<agent_digest>Old digest, done</agent_digest> and some more prose"),
            user("second task"),
        )
        assertNull(TurnPreview.turnPreviewLine(messages))
    }

    @Test
    fun treatsTheWholeListAsTheTurnWhenThereIsNoUserMessage() {
        val messages = listOf(assistant("Reading the config file now"), assistant("<agent_digest>Found it</agent_digest>"))
        assertEquals("Found it", TurnPreview.turnPreviewLine(messages))
    }

    @Test
    fun skipsAnEmptyAssistantMessage() {
        val messages = listOf(user("start"), assistant("<agent_digest>Real status</agent_digest>"), assistant(""))
        assertEquals("Real status", TurnPreview.turnPreviewLine(messages))
    }

    @Test
    fun truncatesALongRawFallbackToSeventyCharsWithAnEllipsis() {
        val preview = TurnPreview.turnPreviewLine(listOf(user("start"), assistant("a".repeat(120))))!!
        assertEquals(70, preview.length)
        assertTrue(preview.endsWith("…"))
    }

    @Test
    fun hidesAStreamingPartialTagFromTheRawFallback() {
        assertEquals("Working on it.", TurnPreview.turnPreviewLine(listOf(user("start"), assistant("Working on it. <agent_di"))))
    }

    @Test
    fun plainTextDropsInlineCodeBoldItalicAndLinkMarkup() {
        assertEquals(
            "pos_gatepass is a column, see docs and this",
            TurnPreview.plainPreviewText("`pos_gatepass` is a **column**, see [docs](https://x.y) and _this_"),
        )
    }

    @Test
    fun plainTextDropsFencedCodeIncludingAStreamingBlock() {
        assertEquals("Fixed it: Done", TurnPreview.plainPreviewText("Fixed it:\n```ts\nconst a = 1\n```\nDone"))
        assertEquals("Running:", TurnPreview.plainPreviewText("Running:\n```sh\nnpm te"))
    }

    @Test
    fun aFenceClosesOnlyAtAMatchingFenceLineAndTildeFencesWork() {
        assertEquals("Before After", TurnPreview.plainPreviewText("Before\n```md\nsee ```not-a-close here\n```\nAfter"))
        assertEquals("Before After", TurnPreview.plainPreviewText("Before\n~~~\ncode\n~~~\nAfter"))
        assertEquals("Before After", TurnPreview.plainPreviewText("Before\n````\n```\ninner\n```\n````\nAfter"))
    }

    @Test
    fun fallsBackToTheRawTextWhenADigestIsOnlyACodeBlock() {
        val message = assistant("Real text here <agent_digest>\n```\ncode\n```\n</agent_digest>")
        assertEquals("Real text here", TurnPreview.turnPreviewLine(listOf(message)))
    }

    @Test
    fun plainTextDropsHeadingQuoteAndListMarkersAndJoinsLines() {
        assertEquals("Summary note one two", TurnPreview.plainPreviewText("## Summary\n> note\n- one\n1. two"))
    }

    @Test
    fun plainTextLeavesSnakeCaseAndMultiplicationAlone() {
        assertEquals("set max_retry_count to 2 * 3", TurnPreview.plainPreviewText("set max_retry_count to 2 * 3"))
    }

    @Test
    fun plainTextIsAppliedToTheRawFallback() {
        assertEquals("The counts mean projects", TurnPreview.turnPreviewLine(listOf(assistant("The counts mean **projects**"))))
    }
}
