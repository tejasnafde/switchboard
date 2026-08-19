package app.switchboard.mobile.domain.remote

import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteGitDecoderTest {
    @Test
    fun `current branch decoder retains named and detached states`() {
        val named = RemoteDecoders.currentBranch(
            obj("ok" to JsonBoolean(true), "branch" to JsonString("feature/native")),
        ) as CurrentBranchResult.Available
        val detached = RemoteDecoders.currentBranch(
            obj("ok" to JsonBoolean(true), "branch" to JsonNull),
        ) as CurrentBranchResult.Available

        assertEquals("feature/native", named.branch)
        assertNull(detached.branch)
    }

    @Test
    fun `current branch decoder preserves safe domain failure metadata`() {
        val result = RemoteDecoders.currentBranch(
            obj(
                "ok" to JsonBoolean(false),
                "error" to JsonString("Folder no longer exists"),
                "missing" to JsonBoolean(true),
            ),
        ) as CurrentBranchResult.Unavailable

        assertEquals("Folder no longer exists", result.message)
        assertTrue(result.missing)
        assertFalse(result.message.contains("token", ignoreCase = true))
    }

    private fun obj(vararg fields: Pair<String, app.switchboard.mobile.protocol.JsonValue>) =
        JsonObject(linkedMapOf(*fields))
}
