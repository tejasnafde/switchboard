package app.switchboard.mobile.ui.navigation

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.ObjectInputStream
import java.io.ObjectOutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class NavigationStateTest {
    @Test
    fun `thread route retains the worktree cwd used for provider reattachment`() {
        val route = AppRoute.Thread(
            connectionId = "mac",
            connectionLabel = "Studio Mac",
            threadId = "thread-1",
            projectPath = "/repo",
            worktreePath = "/repo/.switchboard/worktrees/task",
            title = "Task",
        )

        assertEquals("/repo/.switchboard/worktrees/task", route.worktreePath)
    }

    @Test
    fun pairRoutesPushAndSystemBackReturnsToConnections() {
        val root = NavigationState.root()
        val add = root.push(AppRoute.Pair())
        val manual = root.push(AppRoute.Pair(startManual = true))
        val edit = root.push(AppRoute.Pair(editConnectionId = "machine-1"))

        assertEquals(AppRoute.Pair(), add.current)
        assertEquals(AppRoute.Pair(startManual = true), manual.current)
        assertEquals(AppRoute.Pair(editConnectionId = "machine-1"), edit.current)
        assertTrue(edit.canGoBack)
        assertEquals(AppRoute.Connections, edit.pop().current)
        assertFalse(root.canGoBack)
        assertSame(root, root.pop())
    }

    @Test
    fun googleAccountRouteSerializesAndReturnsToItsCaller() {
        val fromConnections = NavigationState.root().push(AppRoute.GoogleAccount)
        val fromPairing = NavigationState.root()
            .push(AppRoute.Pair(startManual = true))
            .push(AppRoute.GoogleAccount)
        val bytes = ByteArrayOutputStream().also { output ->
            ObjectOutputStream(output).use { it.writeObject(fromPairing) }
        }.toByteArray()

        val restored = ObjectInputStream(ByteArrayInputStream(bytes)).use {
            it.readObject() as NavigationState
        }

        assertEquals(AppRoute.GoogleAccount, fromConnections.current)
        assertEquals(AppRoute.Connections, fromConnections.pop().current)
        assertEquals(AppRoute.GoogleAccount, restored.current)
        assertEquals(AppRoute.Pair(startManual = true), restored.pop().current)
    }

    @Test
    fun routeStackSurvivesJavaSerializationForActivityRecreation() {
        val original = NavigationState.root()
            .push(AppRoute.Browse("machine-1", "Office Mac"))
            .push(
                AppRoute.Browse(
                    connectionId = "machine-1",
                    connectionLabel = "Office Mac",
                    projectPath = "/work/switchboard",
                    projectName = "Switchboard",
                ),
            )
            .push(
                AppRoute.NewSession(
                    connectionId = "machine-1",
                    connectionLabel = "Office Mac",
                    projectPath = "/work/switchboard",
                    projectName = "Switchboard",
                ),
            )
            .replace(
                AppRoute.Thread(
                    connectionId = "machine-1",
                    connectionLabel = "Office Mac",
                    threadId = "thread-1",
                    projectPath = "/work/switchboard",
                    title = "Port Android",
                ),
            )
        val bytes = ByteArrayOutputStream().also { output ->
            ObjectOutputStream(output).use { it.writeObject(original) }
        }.toByteArray()

        val restored = ObjectInputStream(ByteArrayInputStream(bytes)).use {
            it.readObject() as NavigationState
        }

        assertEquals(original, restored)
        assertEquals("thread-1", (restored.current as AppRoute.Thread).threadId)
        assertEquals("/work/switchboard", (restored.pop().current as AppRoute.Browse).projectPath)
        assertEquals(null, (restored.pop().pop().current as AppRoute.Browse).projectPath)
    }

    @Test
    fun browseProjectIdentifiersMustBePresentTogether() {
        val error = runCatching {
            AppRoute.Browse(
                connectionId = "machine-1",
                connectionLabel = "Office Mac",
                projectPath = "/work/switchboard",
            )
        }.exceptionOrNull()

        assertTrue(error is IllegalArgumentException)
    }
}
