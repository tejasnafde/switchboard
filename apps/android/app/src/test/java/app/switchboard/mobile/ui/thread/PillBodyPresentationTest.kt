package app.switchboard.mobile.ui.thread

import app.switchboard.mobile.domain.thread.MessagePill
import org.junit.Assert.assertEquals
import org.junit.Test

class PillBodyPresentationTest {
    @Test
    fun `known token becomes a pill and internal syntax never reaches prose`() {
        val segments = PillBodyPresenter.parse(
            "[[pill:selection-1]] Continue with the staging checks",
            mapOf("selection-1" to MessagePill("Admin panel", "chat-message")),
        )

        assertEquals(
            listOf(
                PillBodySegment.Pill("selection-1", "Admin panel", "chat-message"),
                PillBodySegment.Text(" Continue with the staging checks"),
            ),
            segments,
        )
    }

    @Test
    fun `unknown well formed tokens are dropped while malformed prose is preserved`() {
        assertEquals(
            listOf(PillBodySegment.Text("before  after")),
            PillBodyPresenter.parse("before [[pill:missing]] after", emptyMap()),
        )
        assertEquals(
            listOf(PillBodySegment.Text("literal [[pill:bad id]] text")),
            PillBodyPresenter.parse("literal [[pill:bad id]] text", emptyMap()),
        )
    }

    @Test
    fun `adjacent tokens retain order and pill labels are not recursively parsed`() {
        val segments = PillBodyPresenter.parse(
            "[[pill:a]][[pill:b]]",
            mapOf(
                "a" to MessagePill("A [[pill:b]]", "file"),
                "b" to MessagePill("B", "terminal"),
            ),
        )

        assertEquals(
            listOf(
                PillBodySegment.Pill("a", "A [[pill:b]]", "file"),
                PillBodySegment.Pill("b", "B", "terminal"),
            ),
            segments,
        )
    }
}
