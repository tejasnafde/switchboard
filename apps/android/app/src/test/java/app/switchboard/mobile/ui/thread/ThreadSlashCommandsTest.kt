package app.switchboard.mobile.ui.thread

import app.switchboard.mobile.domain.remote.ProviderSkill
import app.switchboard.mobile.domain.remote.RuntimeMode
import app.switchboard.mobile.protocol.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ThreadSlashCommandsTest {
    @Test
    fun `slash trigger owns the whole draft and ignores paths or trailing arguments`() {
        assertEquals("", ThreadSlashPolicy.query("/"))
        assertEquals("pla", ThreadSlashPolicy.query("/pla"))
        assertNull(ThreadSlashPolicy.query("open /plan"))
        assertNull(ThreadSlashPolicy.query("/plan now"))
        assertNull(ThreadSlashPolicy.query("//plan"))
    }

    @Test
    fun `built-ins own collisions and provider skills stay source ordered`() {
        val commands = ThreadSlashPolicy.commands(
            listOf(
                skill("/clear", "must lose", "codex"),
                skill("commit", "Create commit", "codex", "<message>"),
                skill("commit", "duplicate", "opencode"),
                skill("review", "Review changes", "opencode"),
            ),
        )

        assertEquals(1, commands.count { it.name == "clear" })
        assertEquals(ThreadSlashSource.Switchboard, commands.first { it.name == "clear" }.source)
        assertEquals(listOf("commit", "review"), commands.filter { it.source is ThreadSlashSource.Agent }.map { it.name })
        assertEquals("<message>", commands.first { it.name == "commit" }.argumentHint)
    }

    @Test
    fun `prefix matches rank before substring while action meanings stay absolute`() {
        val commands = ThreadSlashPolicy.commands(listOf(skill("explain", null, "codex")))
        assertEquals(
            listOf("plan", "explain"),
            ThreadSlashPolicy.filter(commands, "pla").map { it.name },
        )
        assertEquals(
            ThreadSlashAction.SetMode(RuntimeMode.Plan),
            commands.first { it.name == "plan" }.action,
        )
        assertEquals(ThreadSlashAction.Interrupt, commands.first { it.name == "stop" }.action)
        assertEquals(ThreadSlashAction.ClearLocalFeed, commands.first { it.name == "clear" }.action)
        assertEquals(ThreadSlashAction.AttachImage, commands.first { it.name == "image" }.action)
        assertEquals(
            ThreadSlashAction.Insert("/explain "),
            commands.first { it.name == "explain" }.action,
        )
    }

    private fun skill(
        name: String,
        description: String?,
        source: String,
        argumentHint: String? = null,
    ) = ProviderSkill(
        name = name,
        description = description,
        argumentHint = argumentHint,
        path = null,
        source = source,
        raw = JsonObject(linkedMapOf()),
    )
}
