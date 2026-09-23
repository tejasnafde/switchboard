package app.switchboard.mobile.domain.remote

import app.switchboard.mobile.protocol.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ModelCatalogReconcileTest {
    @Test
    fun claudeRowCoversAnExactIdMatch() {
        val row = model("claude-sonnet-5")
        assertEquals(true, ModelCatalogReconcile.claudeRowCovers(row, "claude-sonnet-5"))
    }

    @Test
    fun claudeRowCoversWhenItsResolvedModelMatchesTheSelection() {
        val row = model("sonnet", resolvedModel = "claude-sonnet-5")
        assertEquals(true, ModelCatalogReconcile.claudeRowCovers(row, "claude-sonnet-5"))
    }

    @Test
    fun claudeRowCoversTheSameIdModuloACapabilitySuffix() {
        assertEquals(true, ModelCatalogReconcile.claudeRowCovers(model("opus[1m]"), "opus"))
        assertEquals(true, ModelCatalogReconcile.claudeRowCovers(model("opus"), "opus[1m]"))
    }

    @Test
    fun claudeRowDoesNotCoverAnUnrelatedId() {
        assertEquals(false, ModelCatalogReconcile.claudeRowCovers(model("claude-sonnet-5"), "claude-opus-4-7"))
    }

    @Test
    fun claudeRowDoesNotCoverABareFamilyAlias_familyRuleIsNotPorted() {
        // src/shared/model-reconcile.ts rule 4 (a bare alias like "sonnet"
        // covers every shipped id in that family) is deliberately NOT ported -
        // see the class doc. Exact / resolvedModel / suffix-stripped only.
        assertEquals(false, ModelCatalogReconcile.claudeRowCovers(model("sonnet"), "claude-sonnet-5"))
    }

    @Test
    fun exactRowCoversMatchesCodexAndOpenCodeIdsExactly() {
        assertEquals(true, ModelCatalogReconcile.exactRowCovers(model("gpt-5.6-sol"), "gpt-5.6-sol"))
        assertEquals(false, ModelCatalogReconcile.exactRowCovers(model("gpt-5.6-sol"), "gpt-5.4"))
    }

    @Test
    fun reconcileKeepsTheSelectionVerbatimWhenACatalogRowCoversIt() {
        val catalog = listOf(model("opus[1m]"))
        assertEquals(
            "opus",
            ModelCatalogReconcile.reconcileSelectedModel("opus", catalog, ModelCatalogReconcile::claudeRowCovers),
        )
    }

    @Test
    fun reconcileDropsASelectionNoRowCovers() {
        val catalog = listOf(model("claude-sonnet-5"), model("claude-haiku-4-5"))
        assertNull(
            ModelCatalogReconcile.reconcileSelectedModel("claude-opus-4-7", catalog, ModelCatalogReconcile::claudeRowCovers),
        )
    }

    @Test
    fun reconcilePassesThroughWithoutALiveCatalog() {
        assertEquals(
            "claude-opus-4-7",
            ModelCatalogReconcile.reconcileSelectedModel("claude-opus-4-7", emptyList(), ModelCatalogReconcile::claudeRowCovers),
        )
    }

    @Test
    fun coversForPicksTheClaudeRuleOnlyForClaudeCode() {
        assertEquals(true, ModelCatalogReconcile.coversFor("claude-code")(model("opus[1m]"), "opus"))
        assertEquals(false, ModelCatalogReconcile.coversFor("codex")(model("opus[1m]"), "opus"))
    }

    private fun model(id: String, resolvedModel: String? = null) = ModelOption(
        id = id,
        label = id,
        tier = "balanced",
        resolvedModel = resolvedModel,
        raw = JsonObject(linkedMapOf()),
    )
}
