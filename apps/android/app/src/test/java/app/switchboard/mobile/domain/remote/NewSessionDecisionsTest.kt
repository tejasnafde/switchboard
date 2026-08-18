package app.switchboard.mobile.domain.remote

import app.switchboard.mobile.protocol.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NewSessionDecisionsTest {
    @Test
    fun `providers and static model catalogs preserve React Native order`() {
        assertEquals(
            listOf(ProviderKind.Claude, ProviderKind.Codex, ProviderKind.OpenCode),
            NewSessionDecisions.providers.map { it.kind },
        )
        assertEquals(
            listOf("claude-fable-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-5", "claude-sonnet-4-6", "claude-haiku-4-5"),
            NewSessionDecisions.models(ProviderKind.Claude).map { it.id },
        )
        assertEquals("gpt-5.6-sol", NewSessionDecisions.models(ProviderKind.Codex).first().id)
        assertEquals("nvidia-nim/z-ai/glm-5.1", NewSessionDecisions.models(ProviderKind.OpenCode).first().id)
    }

    @Test
    fun `enabled profiles put conventional default first then sort by display name stably`() {
        val rows = listOf(
            instance("z", "claude-code", "Zulu", createdAt = 1),
            instance("claude-code-default", "claude-code", "Default", createdAt = 9),
            instance("a2", "claude-code", "Alpha", createdAt = 3),
            instance("a1", "claude-code", "Alpha", createdAt = 2),
            instance("off", "claude-code", "Off", enabled = false),
            instance("codex-default", "codex", "Codex"),
        )

        assertEquals(
            listOf("claude-code-default", "a1", "a2", "z"),
            NewSessionDecisions.profiles(rows, ProviderKind.Claude).map { it.id },
        )
    }

    @Test
    fun `backend defaults are authoritative and unknown model stays selectable`() {
        val selected = NewSessionDecisions.resolveDefaults(
            provider = ProviderKind.Codex,
            defaults = SessionDefaults("accept-edits", "future-model", "codex-work"),
            profiles = listOf(instance("codex-default", "codex", "Default")),
        )

        assertEquals(RuntimeMode.AcceptEdits, selected.runtimeMode)
        assertEquals("future-model", selected.modelId)
        assertEquals("codex-default", selected.instanceId)
        assertTrue(selected.modelOptions.any { it.id == "future-model" && it.authoritativeDefault })
    }

    @Test
    fun `missing or malformed backend defaults use least privilege explicit fallback`() {
        val selected = NewSessionDecisions.resolveDefaults(
            provider = ProviderKind.Claude,
            defaults = SessionDefaults("dangerous", null, null),
            profiles = emptyList(),
        )

        assertEquals(RuntimeMode.Sandbox, selected.runtimeMode)
        assertEquals(null, selected.modelId)
        assertEquals(null, selected.instanceId)
        assertFalse(selected.modelOptions.any { it.authoritativeDefault })
    }

    private fun instance(
        id: String,
        agentType: String,
        displayName: String,
        enabled: Boolean = true,
        createdAt: Long = 1,
    ) = ProviderInstance(
        id = id,
        agentType = agentType,
        displayName = displayName,
        accentColor = null,
        authMode = "oauth_dir",
        envKeys = emptyList(),
        oauthDir = null,
        enabled = enabled,
        createdAt = createdAt,
        updatedAt = createdAt,
        raw = JsonObject(linkedMapOf()),
    )
}
