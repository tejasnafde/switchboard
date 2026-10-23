package app.switchboard.mobile.ui.thread

import app.switchboard.mobile.domain.remote.RuntimeMode
import org.junit.Assert.assertEquals
import org.junit.Test

class ThreadComposerPresentationPolicyTest {
    @Test
    fun `unfocused composer rests compact even when a draft is ready to send`() {
        assertEquals(
            ThreadComposerDensity.Compact,
            ThreadComposerPresentationPolicy.density(
                focused = false,
                hasAttachments = false,
                hasTransientContent = false,
            ),
        )
    }

    @Test
    fun `focus attachments and transient content expand the composer`() {
        assertEquals(
            ThreadComposerDensity.Expanded,
            ThreadComposerPresentationPolicy.density(true, false, false),
        )
        assertEquals(
            ThreadComposerDensity.Expanded,
            ThreadComposerPresentationPolicy.density(false, true, false),
        )
        assertEquals(
            ThreadComposerDensity.Expanded,
            ThreadComposerPresentationPolicy.density(false, false, true),
        )
    }

    @Test
    fun `one settings affordance summarizes model and runtime`() {
        assertEquals(
            ThreadSettingsAffordance(label = "Claude Sonnet · Supervised"),
            ThreadComposerPresentationPolicy.settingsAffordance(
                modelLabel = " Claude Sonnet ",
                runtimeMode = RuntimeMode.Sandbox,
            ),
        )
        assertEquals(
            "Model · Full access",
            ThreadComposerPresentationPolicy.settingsAffordance(
                modelLabel = null,
                runtimeMode = RuntimeMode.FullAccess,
            ).label,
        )
    }

    @Test
    fun `secondary actions stay hidden until the composer expands or a turn runs`() {
        assertEquals(
            false,
            ThreadComposerPresentationPolicy.showsSecondaryActions(ThreadComposerDensity.Compact, running = false),
        )
        assertEquals(
            true,
            ThreadComposerPresentationPolicy.showsSecondaryActions(ThreadComposerDensity.Expanded, running = false),
        )
        assertEquals(
            true,
            ThreadComposerPresentationPolicy.showsSecondaryActions(ThreadComposerDensity.Compact, running = true),
        )
    }

    @Test
    fun `composer input stays multiline at both densities`() {
        val compact = ThreadComposerPresentationPolicy.inputLayout(ThreadComposerDensity.Compact)
        val expanded = ThreadComposerPresentationPolicy.inputLayout(ThreadComposerDensity.Expanded)

        assertEquals(false, compact.singleLine)
        assertEquals(false, expanded.singleLine)
        assertEquals(5, compact.maxLines)
        assertEquals(5, expanded.maxLines)
    }
}
