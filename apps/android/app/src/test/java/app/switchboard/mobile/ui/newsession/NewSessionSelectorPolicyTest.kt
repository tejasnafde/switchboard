package app.switchboard.mobile.ui.newsession

import app.switchboard.mobile.domain.remote.NewSessionModelOption
import app.switchboard.mobile.domain.remote.ProviderInstance
import app.switchboard.mobile.domain.remote.ProviderKind
import app.switchboard.mobile.domain.remote.RuntimeMode
import app.switchboard.mobile.protocol.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Test

class NewSessionSelectorPolicyTest {
    @Test
    fun selectorsExposeOneCalmCurrentValue() {
        assertEquals("Claude", NewSessionSelectorPolicy.providerLabel(ProviderKind.Claude))
        assertEquals("Codex", NewSessionSelectorPolicy.providerLabel(ProviderKind.Codex))
        assertEquals("OpenCode", NewSessionSelectorPolicy.providerLabel(ProviderKind.OpenCode))
        assertEquals("Sandbox", NewSessionSelectorPolicy.runtimeLabel(RuntimeMode.Sandbox))
        assertEquals("Accept edits", NewSessionSelectorPolicy.runtimeLabel(RuntimeMode.AcceptEdits))
    }

    @Test
    fun profileAndModelSelectorsHaveStableFallbacks() {
        val profiles = listOf(profile("work", "Work"))
        val models = listOf(NewSessionModelOption("sonnet", "Sonnet", "recommended"))

        assertEquals("Loading profiles…", NewSessionSelectorPolicy.profileLabel(true, profiles, "work"))
        assertEquals("Work", NewSessionSelectorPolicy.profileLabel(false, profiles, "work"))
        assertEquals("Default profile", NewSessionSelectorPolicy.profileLabel(false, profiles, null))
        assertEquals("Backend default", NewSessionSelectorPolicy.modelLabel(models, null))
        assertEquals("Sonnet", NewSessionSelectorPolicy.modelLabel(models, "sonnet"))
    }

    @Test
    fun selectorRowsExposeConciseSupportingCopy() {
        assertEquals("Agent", NewSessionSelectorPolicy.supportingLabel(NewSessionField.PROVIDER))
        assertEquals("Profile", NewSessionSelectorPolicy.supportingLabel(NewSessionField.PROFILE))
        assertEquals("Model", NewSessionSelectorPolicy.supportingLabel(NewSessionField.MODEL))
        assertEquals("Access", NewSessionSelectorPolicy.supportingLabel(NewSessionField.RUNTIME))
        assertEquals("Workspace", NewSessionSelectorPolicy.supportingLabel(NewSessionField.WORKSPACE))
    }

    private fun profile(id: String, displayName: String) = ProviderInstance(
        id = id,
        agentType = "claude",
        displayName = displayName,
        accentColor = null,
        authMode = "oauth_dir",
        envKeys = emptyList(),
        oauthDir = null,
        enabled = true,
        createdAt = 0,
        updatedAt = 0,
        raw = JsonObject(linkedMapOf()),
    )
}
