package app.switchboard.mobile.domain.thread

import app.switchboard.mobile.ui.thread.ThreadPresenter
import app.switchboard.mobile.ui.thread.ThreadRowPresentation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SyntheticUserMessageTest {
    // Real transcript sample, ids and paths redacted.
    private val failed = """
        <task-notification>
        <task-id>b000000aa</task-id>
        <tool-use-id>toolu_01REDACTED</tool-use-id>
        <output-file>/private/tmp/claude-501/x/tasks/b000000aa.output</output-file>
        <status>failed</status>
        <summary>Background command "Wait for the first extra-account job to finish" failed with exit code 144</summary>
        </task-notification>
    """.trimIndent()

    @Test
    fun `task notification becomes a labelled part with details`() {
        val split = SyntheticUserMessage.split("$failed\nContinue from where you left off.")!!
        assertEquals("Continue from where you left off.", split.userText)
        val part = split.parts.single()
        assertEquals(
            "Background task failed: Wait for the first extra-account job to finish (exit 144)",
            SyntheticUserMessage.label(part),
        )
        assertEquals(SyntheticTone.ERROR, SyntheticUserMessage.tone(part))
        assertEquals(
            "Background command \"Wait for the first extra-account job to finish\" failed with exit code 144\n" +
                "Task: b000000aa\nOutput: /private/tmp/claude-501/x/tasks/b000000aa.output",
            SyntheticUserMessage.detail(part),
        )
    }

    @Test
    fun `interrupts, command output and context blocks`() {
        assertEquals(
            listOf(SyntheticPart.Interrupted(true)),
            SyntheticUserMessage.split("[Request interrupted by user for tool use]")!!.parts,
        )
        assertEquals(
            listOf(SyntheticPart.CommandOutput("Set model to x", false)),
            SyntheticUserMessage.split("<local-command-stdout>Set model to x</local-command-stdout>")!!.parts,
        )
        assertEquals(
            SyntheticSplit(emptyList(), "fix it"),
            SyntheticUserMessage.split("<environment_context>\n<cwd>/r</cwd>\n</environment_context>\nfix it"),
        )
        assertNull(UserMessageVisibility.visibleText("<local-command-caveat>x</local-command-caveat>", null))
    }

    @Test
    fun `real messages are left alone`() {
        assertNull(SyntheticUserMessage.split("What does <task-notification> mean?"))
        assertNull(SyntheticUserMessage.split("<task-notification> unterminated"))
    }

    @Test
    fun `presenter renders a notification row instead of a user bubble`() {
        val rows = ThreadPresenter.rows(FeedItem.User(id = "h-1", text = failed, at = 1, fromTranscript = true))
        val row = rows.single() as ThreadRowPresentation.Synthetic
        assertEquals("h-1-s0", row.key)
        assertEquals(SyntheticTone.ERROR, row.tone)
    }

    @Test
    fun `typed text that starts with a marker stays a user bubble`() {
        val typed = FeedItem.User(id = "remote_1", text = "[Request interrupted by user] why did you stop?", at = 1)
        val row = ThreadPresenter.rows(typed).single() as ThreadRowPresentation.User
        assertEquals(typed, row.source)
    }

}
