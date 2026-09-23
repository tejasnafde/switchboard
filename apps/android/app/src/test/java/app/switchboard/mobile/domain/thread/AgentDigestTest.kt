package app.switchboard.mobile.domain.thread

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentDigestTest {
    @Test
    fun `extractDigest returns null for empty text`() {
        assertNull(AgentDigest.extractDigest(""))
    }

    @Test
    fun `extractDigest returns null when no tag is present`() {
        assertNull(AgentDigest.extractDigest("Just some plain assistant text."))
    }

    @Test
    fun `extractDigest extracts a single complete tag, trimmed`() {
        assertEquals(
            "Reading config files",
            AgentDigest.extractDigest("<agent_digest>  Reading config files  </agent_digest>"),
        )
    }

    @Test
    fun `extractDigest returns the last complete tag when several are present`() {
        val text = "<agent_digest>Step one</agent_digest> prose " +
            "<agent_digest>Step two</agent_digest> prose " +
            "<agent_digest>Done: all steps finished</agent_digest>"
        assertEquals("Done: all steps finished", AgentDigest.extractDigest(text))
    }

    @Test
    fun `extractDigest ignores an unclosed trailing tag and falls back to the last complete one`() {
        val text = "<agent_digest>Step one</agent_digest> now streaming <agent_digest>Step tw"
        assertEquals("Step one", AgentDigest.extractDigest(text))
    }

    @Test
    fun `extractDigest returns null for an unclosed tag with nothing before it`() {
        assertNull(AgentDigest.extractDigest("<agent_digest>still typing"))
    }

    @Test
    fun `extractDigest skips a whitespace-only digest body`() {
        assertNull(AgentDigest.extractDigest("<agent_digest>   </agent_digest>"))
    }

    @Test
    fun `extractDigest caps the digest at about 120 chars with an ellipsis`() {
        val long = "x".repeat(200)
        val digest = AgentDigest.extractDigest("<agent_digest>$long</agent_digest>")
        assertEquals(120, digest?.length)
        assertTrue(digest!!.endsWith("…"))
        assertTrue(digest.startsWith("x".repeat(119)))
    }

    @Test
    fun `extractDigest does not cap a digest exactly at the limit`() {
        val exact = "x".repeat(120)
        assertEquals(exact, AgentDigest.extractDigest("<agent_digest>$exact</agent_digest>"))
    }

    @Test
    fun `stripDigest returns text unchanged when no tag is present`() {
        assertEquals("Just some plain text.", AgentDigest.stripDigest("Just some plain text."))
    }

    @Test
    fun `stripDigest removes a single complete tag`() {
        assertEquals(
            "Hello  world",
            AgentDigest.stripDigest("Hello <agent_digest>Working</agent_digest> world"),
        )
    }

    @Test
    fun `stripDigest removes multiple complete tags`() {
        val text = "<agent_digest>Step one</agent_digest>body one" +
            "<agent_digest>Step two</agent_digest>body two"
        assertEquals("body onebody two", AgentDigest.stripDigest(text))
    }

    @Test
    fun `stripDigest hides a fully unclosed trailing tag and its partial body`() {
        assertEquals(
            "Working on it. ",
            AgentDigest.stripDigest("Working on it. <agent_digest>Writing te"),
        )
    }

    @Test
    fun `stripDigest hides an unclosed tag with a partial close tag in progress`() {
        assertEquals(
            "Working on it. ",
            AgentDigest.stripDigest("Working on it. <agent_digest>Writing tests</agent_dig"),
        )
    }

    @Test
    fun `stripDigest hides a bare partial prefix of the open tag at the end of the text`() {
        assertEquals("Working on it. ", AgentDigest.stripDigest("Working on it. <agent_di"))
    }

    @Test
    fun `stripDigest hides the shortest partial prefix - a single trailing angle bracket`() {
        assertEquals("Working on it. ", AgentDigest.stripDigest("Working on it. <"))
    }

    @Test
    fun `stripDigest does not touch an angle bracket not followed by tag-prefix characters`() {
        assertEquals("if (x < 5) return", AgentDigest.stripDigest("if (x < 5) return"))
    }

    @Test
    fun `stripDigest does not touch an unrelated trailing tag`() {
        assertEquals("some <b>bold</b> text", AgentDigest.stripDigest("some <b>bold</b> text"))
    }

    @Test
    fun `stripDigest keeps prose between a complete tag and a later unclosed one`() {
        val text = "<agent_digest>first</agent_digest> body text <agent_digest>second"
        assertEquals(" body text ", AgentDigest.stripDigest(text))
    }

    @Test
    fun `stripDigest progressively strips a tag as it streams in, character by character`() {
        val full = "Working on it. <agent_digest>Writing tests, 2 of 4 done</agent_digest>"
        val prefixes = listOf(
            "Working on it. <",
            "Working on it. <a",
            "Working on it. <agent_dig",
            "Working on it. <agent_digest>",
            "Working on it. <agent_digest>Writing",
            "Working on it. <agent_digest>Writing tests, 2 of 4 done",
            "Working on it. <agent_digest>Writing tests, 2 of 4 done</agent_dig",
        )
        for (partial in prefixes) {
            assertEquals("Working on it. ", AgentDigest.stripDigest(partial))
        }
        assertEquals("Working on it. ", AgentDigest.stripDigest(full))
    }
}
