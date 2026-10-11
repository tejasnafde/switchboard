package app.switchboard.mobile.domain.thread

import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Branches of the SubagentSteps port that tests/fixtures/subagent-cases.json does not reach. */
class SubagentStepsTest {
    private val label: SubagentToolLabel = { name, _ -> name }

    @Test
    fun durationsReadInSecondsMinutesAndHours() {
        assertEquals("0s", SubagentSteps.formatDuration(-5))
        assertEquals("42s", SubagentSteps.formatDuration(41_600))
        assertEquals("6m 02s", SubagentSteps.formatDuration(362_000))
        assertEquals("1h 05m", SubagentSteps.formatDuration(3_900_000))
    }

    @Test
    fun resultTextDropsTheAgentIdAndUsageTrailer() {
        assertEquals(
            "Report line one.\nTwo.",
            SubagentSteps.resultText("Report line one.\nTwo.\nagentId: a1 (use SendMessage)\n<usage>tool_uses: 3</usage>\n"),
        )
        assertEquals("No trailer.", SubagentSteps.resultText("No trailer."))
    }

    @Test
    fun anErrorWithNoTextFailsWithAPlainReason() {
        val view = SubagentSteps.view(SubagentCall(input = null, output = null, isError = true), emptyList(), toolLabel = label)
        assertEquals(SubagentStatus.FAILED, view.status)
        assertEquals("Subagent", view.description)
        assertEquals("Failed · Failed", SubagentSteps.statusText(view))
    }

    @Test
    fun inputAsJsonTextStillNamesTheAgentAndModel() {
        val input = JsonString("{\"description\":\"Scan\",\"model\":\"haiku\"}")
        val view = SubagentSteps.view(SubagentCall(input = input), emptyList(), toolLabel = label)
        assertEquals("Scan", view.description)
        assertEquals("haiku", view.model)
        assertEquals("Starting", SubagentSteps.statusText(view))
    }

    @Test
    fun aRunningAgentNamesItsLatestStepThroughTheToolLabel() {
        val view = SubagentSteps.view(
            SubagentCall(input = JsonObject(linkedMapOf("description" to JsonString("d")))),
            listOf(
                SubagentStep.Text("t1", "  \n  Looking at the code\nmore"),
                SubagentStep.Tool("s1", "Bash", JsonObject(linkedMapOf("n" to JsonNumber("1")))),
            ),
            toolLabel = label,
        )
        assertEquals("Step 2 · Bash", SubagentSteps.statusText(view))
        assertEquals("Looking at the code", SubagentSteps.stepLabel(SubagentStep.Text("t", "\nLooking at the code\nx"), label))
    }

    @Test
    fun aCompletionWithoutAStartTimeHasNoDuration() {
        val done = SyntheticPart.TaskNotification("completed", "Agent \"x\" finished", null, null)
        val view = SubagentSteps.view(
            SubagentCall(input = null, output = "Async agent launched successfully."),
            emptyList(),
            listOf(SubagentCompletion(done, at = 5_000)),
            label,
        )
        assertEquals(SubagentStatus.DONE, view.status)
        assertNull(view.durationMs)
        assertEquals("Done", SubagentSteps.statusText(view))
    }

    @Test
    fun noticesThatStoppedReadAsFinished() {
        fun notice(key: String, status: String) =
            SubagentStep.Notice(key, SyntheticPart.TaskNotification(status, "Background command \"$key\" $status", null, null))
        val items = SubagentSteps.displayItems(listOf(notice("a", "completed"), notice("b", "stopped")))
        assertEquals(listOf("2 background tasks finished"), items.map { (it as SubagentDisplayItem.Notices).label })
    }

    @Test
    fun taskNoticeToolUseIdRoundTripsAndTheResultParses() {
        val text = SyntheticUserMessage.taskNotificationText("t1", "completed", "s", null, toolUseId = "toolu_1")
        val part = SyntheticUserMessage.split(text)!!.parts.single() as SyntheticPart.TaskNotification
        assertEquals("toolu_1", part.toolUseId)
        assertEquals(text, SyntheticUserMessage.taskNotificationText("t1", "completed", "s", null, "toolu_1"))
        assertEquals(
            "<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n<summary>s</summary>\n</task-notification>",
            SyntheticUserMessage.taskNotificationText("t1", "completed", "s", null),
        )

        val transcript = "<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>toolu_9</tool-use-id>\n" +
            "<status>completed</status>\n<summary>Agent \"x\" finished</summary>\n<result>Report.</result>\n</task-notification>"
        val parsed = SyntheticUserMessage.split(transcript)!!.parts.single() as SyntheticPart.TaskNotification
        assertEquals("toolu_9", parsed.toolUseId)
        assertEquals("Report.", parsed.result)
    }

    @Test
    fun theNoticeLabelUsesTheBackgroundTaskLabel() {
        val part = SyntheticPart.TaskNotification(
            "failed",
            "Background command \"cd /repo && npm test\" failed with exit code 1",
            null,
            null,
        )
        assertEquals("Background task failed: npm test (exit 1)", SyntheticUserMessage.label(part))
    }
}
