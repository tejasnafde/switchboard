package app.switchboard.mobile.ui.thread

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Same cases as tests/unit/compaction-offer.test.ts. */
class CompactionOfferPolicyTest {
    private val now = 1_800_000_000_000L
    private val base = CompactionOfferPolicy.Input(
        provider = "claude-code",
        usedTokens = CompactionOfferPolicy.MIN_TOKENS,
        lastMessageAtMs = now - CompactionOfferPolicy.MIN_IDLE_MS,
        busy = false,
        nowMs = now,
    )

    @Test
    fun offersForAStaleHeavyIdleClaudeThread() {
        assertTrue(CompactionOfferPolicy.shouldOffer(base))
    }

    @Test
    fun acceptsThePhoneVocabularyToo() {
        assertTrue(CompactionOfferPolicy.shouldOffer(base.copy(provider = "claude")))
    }

    @Test
    fun declinesForCodex() {
        assertFalse(CompactionOfferPolicy.shouldOffer(base.copy(provider = "codex")))
    }

    @Test
    fun declinesWhenLight() {
        assertFalse(CompactionOfferPolicy.shouldOffer(base.copy(usedTokens = CompactionOfferPolicy.MIN_TOKENS - 1)))
    }

    @Test
    fun declinesWhenRecent() {
        assertFalse(
            CompactionOfferPolicy.shouldOffer(
                base.copy(lastMessageAtMs = now - CompactionOfferPolicy.MIN_IDLE_MS + 1),
            ),
        )
    }

    @Test
    fun declinesWhenBusy() {
        assertFalse(CompactionOfferPolicy.shouldOffer(base.copy(busy = true)))
    }

    @Test
    fun declinesWithNoUsage() {
        assertFalse(CompactionOfferPolicy.shouldOffer(base.copy(usedTokens = null)))
    }

    @Test
    fun declinesWithNoMessages() {
        assertFalse(CompactionOfferPolicy.shouldOffer(base.copy(lastMessageAtMs = null)))
    }
}
