package app.switchboard.mobile.ui.thread

/**
 * Kotlin port of src/shared/compaction-offer.ts `shouldOfferCompaction`. Same
 * thresholds, same rule: a Claude thread that is both token-heavy and stale
 * is cheaper to continue after `/compact`.
 */
object CompactionOfferPolicy {
    const val MIN_TOKENS = 100_000L
    const val MIN_IDLE_MS = 70 * 60_000L

    data class Input(
        /** Android's ProviderKind wire value is "claude"; the desktop/backend
         *  spelling "claude-code" is accepted too, mirroring the TS union. */
        val provider: String?,
        val usedTokens: Long?,
        val lastMessageAtMs: Long?,
        val busy: Boolean,
        val nowMs: Long,
    )

    fun shouldOffer(input: Input): Boolean {
        // Claude only. Codex has /compact too but its adapter reports no
        // compaction status, so the meter would not move after the click.
        if (input.provider != "claude-code" && input.provider != "claude") return false
        if (input.busy) return false
        val usedTokens = input.usedTokens ?: return false
        if (usedTokens < MIN_TOKENS) return false
        val lastMessageAt = input.lastMessageAtMs ?: return false
        return input.nowMs - lastMessageAt >= MIN_IDLE_MS
    }
}
