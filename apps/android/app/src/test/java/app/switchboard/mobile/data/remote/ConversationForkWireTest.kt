package app.switchboard.mobile.data.remote

import app.switchboard.mobile.domain.remote.ChatMessage
import app.switchboard.mobile.domain.remote.ForkConversationOutcome
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ConversationForkWireTest {
    @Test
    fun `request has deterministic id and canonical message digest`() {
        val raw = JsonCodec.parse("""{"timestamp":1,"id":"message-1","role":"user","content":"hi"}""") as JsonObject
        val message = ChatMessage("message-1", "user", "hi", 1, raw)

        val first = ConversationForkWire.request("request-1", "source", message, false, 10)
        val retry = ConversationForkWire.request("request-1", "source", message, false, 20)
        val anchor = first.raw.values.getValue("anchor") as JsonObject

        assertEquals("request-1", retry.requestId)
        assertEquals(
            "68ba30e55cb98e4c76bef07019f992ede55161cb2298f57db884a6b592f7cff2",
            (anchor.values.getValue("contentDigest") as JsonString).value,
        )
    }

    @Test
    fun `completed result preserves authoritative project and worktree identity`() {
        val outcome = ConversationForkWire.outcome(JsonCodec.parse("""
          {"kind":"completed","result":{"requestId":"request-1","conversation":{
            "id":"fork-1","projectPath":"/repo","worktreePath":"/repo/.switchboard/worktrees/fork-1",
            "worktreeBranch":"fork/fix","worktreeId":"worktree-1","agentType":"codex",
            "providerInstanceId":"codex-work","runtimeMode":"sandbox","model":"gpt-5",
            "reasoningEffort":"high","title":"Source · fork/fix","parentConversationId":"source",
            "parentTitle":"Source","resumeMode":"transcript-handoff",
            "anchor":{"messageId":"message-1","preview":"Fix it"}},"messages":[],"warnings":[]}}
        """))

        assertTrue(outcome is ForkConversationOutcome.Completed)
        val completed = outcome as ForkConversationOutcome.Completed
        assertEquals("/repo", completed.result.conversation.projectPath)
        assertEquals("/repo/.switchboard/worktrees/fork-1", completed.result.conversation.worktreePath)
        assertEquals("codex-work", completed.result.conversation.providerInstanceId)
    }
}
