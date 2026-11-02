package app.switchboard.mobile.domain.thread

import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HubChildrenTest {
    private val view = HubChildren.decode(
        JsonCodec.parse(
            """
            {
              "self": {"id": "p1", "familyIds": ["p1", "p1-live"], "title": "Hub", "agentType": "claude-code", "projectPath": "/repo", "updatedAt": 5},
              "parent": null,
              "state": "waiting",
              "heldUpdates": 2,
              "children": [
                {"chat": {"id": "c1", "familyIds": ["c1"], "title": "Local", "agentType": "codex", "projectPath": "/repo", "worktreePath": "/repo/.switchboard/worktrees/c1", "updatedAt": 6},
                 "liveId": "c1-live", "phase": "open", "state": "working", "limit": "none", "waitingForSlot": false,
                 "account": null, "branch": "hub/c1", "lastWake": {"kind": "report", "summary": "Tests pass"}, "lastTurn": null},
                {"chat": {"id": "c2", "familyIds": ["c2"], "title": "Remote", "agentType": "claude-code", "projectPath": "/srv/repo", "updatedAt": 7},
                 "liveId": null, "phase": "open", "state": "needs_you", "limit": "none", "waitingForSlot": false,
                 "account": null, "branch": null, "lastWake": null, "lastTurn": null,
                 "remote": {"machineId": "vm-1", "machine": "build-vm", "connected": true, "ageMs": 0, "stopping": false}},
                {"chat": {"id": "c3", "familyIds": ["c3"], "title": "Future", "agentType": "codex", "projectPath": "/repo", "updatedAt": 8},
                 "liveId": null, "phase": "open", "state": "hibernating", "limit": "none", "waitingForSlot": false,
                 "account": null, "branch": null, "lastWake": null, "lastTurn": null}
              ]
            }
            """.trimIndent(),
        ),
    )

    @Test
    fun decodesALocalAndARemoteChildAndKeepsAnUnknownStateAsUnknown() {
        assertEquals("p1", view.self?.id)
        assertEquals(listOf("p1", "p1-live"), view.self?.familyIds)
        assertNull(view.parent)
        assertEquals(ParentState.Waiting, view.state)
        assertEquals(2L, view.heldUpdates)
        assertEquals(listOf("c1", "c2", "c3"), view.children.map { it.chat.id })
        assertEquals(ChildState.Unknown, view.children[2].state)
        assertEquals("Unknown state", HubChildren.childStateLabel(view.children[2]))
        assertEquals("Unknown state", HubChildren.childStateWord(view.children[2]))

        val local = view.children[0]
        assertEquals("c1-live", local.liveId)
        assertEquals("/repo/.switchboard/worktrees/c1", local.chat.worktreePath)
        assertNull(view.children[1].chat.worktreePath)
        assertEquals(ChildState.Working, local.state)
        assertEquals(HubWake("report", "Tests pass"), local.lastWake)
        assertNull(local.remote)

        val remote = view.children[1]
        assertEquals(HubRemoteChild("vm-1", "build-vm", connected = true, ageMs = 0, stopping = false), remote.remote)
        assertEquals("Needs approval on build-vm", HubChildren.childStateLabel(remote))
    }

    @Test
    fun theChipNamesTheMachinesOnlyWithTheRemoteFields() {
        assertEquals("Hub · 3 children on 2 machines · Waiting for children", HubChildren.chipText(view))
        val local = view.withoutRemote()
        assertEquals("Hub · 3 children · Waiting for children", HubChildren.chipText(local))
        assertEquals("Needs you", HubChildren.childStateLabel(local.children[1]))
        assertFalse(HubChildren.canStop(local.children[1]))
        assertNull(HubChildren.stopTarget(local.children[1]))
    }

    @Test
    fun anUnknownParentStateAndAnEmptyAnswerDecodeWithoutChildren() {
        assertNull(HubChildren.decode(JsonCodec.parse("""{"self":null,"parent":null,"children":[],"state":"dozing"}""")).state)
        assertEquals(HubChatView.EMPTY, HubChildren.decode(JsonNull))
    }

    @Test
    fun aRowUnderAListedParentIsLeftOutAndAnOrphanStays() {
        val rows = listOf("p" to null, "c" to "p", "orphan" to "gone")
        assertEquals(listOf("p", "orphan"), HubChildren.topLevel(rows, { it.first }, { it.second }).map { it.first })
        assertTrue(HubChildren.topLevel(emptyList<Pair<String, String?>>(), { it.first }, { it.second }).isEmpty())
    }

    @Test
    fun agesRoundLikeTheDesktop() {
        assertEquals("40 s", HubChildren.formatAge(40_000))
        assertEquals("3 min", HubChildren.formatAge(180_000))
        assertEquals("2 h", HubChildren.formatAge(7_200_000))
        assertEquals("4 days", HubChildren.formatAge(4 * 86_400_000L))
    }
}
