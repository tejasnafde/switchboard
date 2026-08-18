package app.switchboard.mobile.ui.browse

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.ObjectInputStream
import java.io.ObjectOutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class BrowseNavigationTest {
    @Test
    fun projectsOpenConversationsAndBackReturnsToProjects() {
        val root = BrowseNavigationState.root()
        val conversations = root.openProject("/work/switchboard", "Switchboard")

        assertEquals(
            BrowseRoute.Conversations("/work/switchboard", "Switchboard"),
            conversations.current,
        )
        assertTrue(conversations.canGoBack)
        assertEquals(BrowseRoute.Projects, conversations.back().current)
        assertFalse(root.canGoBack)
        assertSame(root, root.back())
    }

    @Test
    fun selectedProjectSurvivesActivityAndProcessRecreation() {
        val original = BrowseNavigationState.root().openProject("/work/switchboard", "Switchboard")
        val bytes = ByteArrayOutputStream().also { output ->
            ObjectOutputStream(output).use { it.writeObject(original) }
        }.toByteArray()

        val restored = ObjectInputStream(ByteArrayInputStream(bytes)).use {
            it.readObject() as BrowseNavigationState
        }

        assertEquals(original, restored)
    }
}
