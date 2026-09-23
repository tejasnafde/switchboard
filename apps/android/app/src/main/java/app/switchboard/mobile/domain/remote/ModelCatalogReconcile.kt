package app.switchboard.mobile.domain.remote

/**
 * Is a picked model still offered by the provider's live catalog? Kotlin port
 * of a deliberately small subset of src/shared/model-reconcile.ts's
 * `claudeRowCovers` and `reconcileSelectedModel`.
 *
 * Ported rules (of the four in claudeRowCovers):
 *  1. The row IS the selection (exact id match).
 *  2. The row's `resolvedModel` matches the selection (the CLI's own answer).
 *  3. Same id modulo a trailing capability suffix: `opus[1m]` covers `opus`.
 *
 * NOT ported: rule 4, the bare-family-alias rule (`sonnet` covers
 * `claude-sonnet-5` because this build ships that id). That rule needs the
 * shipped-model-id allowlist from src/shared/models.ts, which the task asked
 * to leave out of this port - Android just uses the three simpler rules.
 */
object ModelCatalogReconcile {
    /** One trailing bracketed capability marker: `opus[1m]` -> `opus`. */
    private val CAPABILITY_SUFFIX = Regex("""\[[^]]*]$""")

    private fun baseId(id: String): String = id.replace(CAPABILITY_SUFFIX, "").trim().lowercase()

    /** Does this catalog row vouch for `selected`? Rules 1-3 above. */
    fun claudeRowCovers(row: ModelOption, selected: String): Boolean {
        if (row.id == selected) return true
        val resolvedModel = row.resolvedModel
        if (resolvedModel != null && baseId(resolvedModel) == baseId(selected)) return true
        return baseId(row.id) == baseId(selected)
    }

    /** Exact ids only: right for Codex/OpenCode, whose rows are the ids they accept. */
    fun exactRowCovers(row: ModelOption, selected: String): Boolean = row.id == selected

    /** The matching rule for an agent's catalog. */
    fun coversFor(agentType: String): (ModelOption, String) -> Boolean =
        if (agentType == "claude-code") ::claudeRowCovers else ::exactRowCovers

    /**
     * A selection made before the live catalog existed must not go on being
     * sent once the live catalog no longer offers it. The selection is
     * returned VERBATIM when kept - never rewritten to the row that covered
     * it. An empty catalog passes the pick through unchanged: no live
     * evidence to contradict it.
     */
    fun reconcileSelectedModel(
        selected: String?,
        catalog: List<ModelOption>,
        covers: (ModelOption, String) -> Boolean,
    ): String? {
        if (selected.isNullOrEmpty()) return selected
        if (catalog.isEmpty()) return selected
        return if (catalog.any { covers(it, selected) }) selected else null
    }
}
