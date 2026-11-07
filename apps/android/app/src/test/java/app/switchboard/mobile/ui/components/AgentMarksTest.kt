package app.switchboard.mobile.ui.components

import java.nio.file.Files
import java.nio.file.Path
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The drawables come from src/shared/agent-marks.ts (see
 * tests/unit/android-agent-mark-drawables.test.ts). This checks the Kotlin
 * mapping names every one of them, so a mark added for the desktop and the
 * phones cannot reach Android as a file nothing draws.
 */
class AgentMarksTest {
    @Test
    fun everyGeneratedDrawableIsMapped() {
        val names = Files.list(drawableDir()).use { paths ->
            paths.map { it.fileName.toString() }
                .filter { it.startsWith("agent_mark_") && it.endsWith(".xml") }
                .map { it.removePrefix("agent_mark_").removeSuffix(".xml").replace('_', '-') }
                .sorted()
                .toList()
        }
        assertEquals(
            listOf("claude-code", "cline", "codex", "copilot", "gemini", "opencode", "vibe").sorted(),
            names,
        )
        names.forEach { assertNotNull(it, AgentMarks.drawableFor(it)) }
    }

    @Test
    fun takesTheWireSpellingOfClaudeAndRefusesToGuess() {
        assertEquals(AgentMarks.drawableFor("claude-code"), AgentMarks.drawableFor("claude"))
        assertNull(AgentMarks.drawableFor("acp-command"))
        assertNull(AgentMarks.drawableFor("some-future-agent"))
        assertNull(AgentMarks.drawableFor(null))
    }

    private fun drawableDir(): Path = generateSequence(Path.of("").toAbsolutePath()) { it.parent }
        .map { it.resolve("apps/android/app/src/main/res/drawable") }
        .firstOrNull(Files::isDirectory)
        ?: error("Missing apps/android/app/src/main/res/drawable")
}
