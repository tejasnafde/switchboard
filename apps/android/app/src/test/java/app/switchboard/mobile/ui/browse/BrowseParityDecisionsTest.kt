package app.switchboard.mobile.ui.browse

import app.switchboard.mobile.domain.remote.Project
import app.switchboard.mobile.domain.remote.SessionSummary
import app.switchboard.mobile.domain.remote.Workspace
import app.switchboard.mobile.protocol.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BrowseParityDecisionsTest {
    @Test
    fun `project search threshold and name or path matching mirror React Native`() {
        assertFalse(BrowseParityDecisions.showProjectSearch(6, ""))
        assertTrue(BrowseParityDecisions.showProjectSearch(7, ""))
        assertTrue(BrowseParityDecisions.showProjectSearch(1, "x"))
        assertTrue(BrowseParityDecisions.projectMatches(project("Switchboard", "/work/app"), "board"))
        assertTrue(BrowseParityDecisions.projectMatches(project("Other", "/work/switchboard"), "BOARD"))
        assertFalse(BrowseParityDecisions.projectMatches(project("Other", "/work/app"), "board"))
    }

    @Test
    fun `conversation search appears after eight and matches title only`() {
        assertFalse(BrowseParityDecisions.showConversationSearch(8, ""))
        assertTrue(BrowseParityDecisions.showConversationSearch(9, ""))
        assertTrue(BrowseParityDecisions.conversationTitleMatches("Release Work", "work"))
        assertFalse(BrowseParityDecisions.conversationTitleMatches("Release Work", "release/work"))
    }

    @Test
    fun `multiple workspace groups collapse only without a live query`() {
        val groups = BrowseParityDecisions.sections(
            projects = listOf(
                project("A", "/a", "one"),
                project("B", "/b", "two"),
            ),
            workspaces = listOf(workspace("one", "One", 2), workspace("two", "Two", 1)),
            collapsedWorkspaceIds = setOf("two"),
            query = "",
        )

        assertEquals(listOf("two", "one"), groups.map { it.key })
        assertTrue(groups.first().collapsed)
        assertEquals(emptyList<Project>(), groups.first().projects)

        val searching = BrowseParityDecisions.sections(
            projects = listOf(project("B", "/b", "two")),
            workspaces = listOf(workspace("one", "One", 2), workspace("two", "Two", 1)),
            collapsedWorkspaceIds = setOf("two"),
            query = "b",
        )
        assertFalse(searching.single().collapsed)
        assertEquals("/b", searching.single().projects.single().path)
    }

    @Test
    fun `activity totals unread and selects the strongest project status`() {
        val activity = mapOf(
            "a" to BrowseThreadActivity("running", 2),
            "b" to BrowseThreadActivity("error", 3),
            "c" to BrowseThreadActivity("idle", 7),
        )

        val summary = BrowseParityDecisions.projectActivity(listOf("a", "b"), activity)

        assertEquals(5, summary.unread)
        assertEquals("error", summary.status)
    }

    private fun project(name: String, path: String, workspaceId: String? = null) = Project(
        path = path,
        name = name,
        sessions = listOf(SessionSummary(name, "codex", name, 1, 1, "$path.jsonl", json())),
        workspaceId = workspaceId,
        raw = json(),
    )

    private fun workspace(id: String, name: String, sortOrder: Long) = Workspace(
        id = id,
        name = name,
        color = null,
        sortOrder = sortOrder,
        createdAt = 1,
        raw = json(),
    )

    private fun json() = JsonObject(linkedMapOf())
}
