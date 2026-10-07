package app.switchboard.mobile.domain.remote

import app.switchboard.mobile.domain.thread.PrLink
import app.switchboard.mobile.domain.thread.PrLinkRef
import app.switchboard.mobile.domain.thread.PrLinkUnlinkResult
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonNull
import org.junit.Assert.assertEquals
import org.junit.Test

class RemotePrLinksDecoderTest {
    @Test
    fun `pull-requests links decodes state and stateAt when present`() {
        val reply = JsonCodec.parse(
            """
            [
              {"ref":{"host":"github","owner":"acme","name":"app","number":612},"source":"auto","linkedAt":1,"state":"open","stateAt":2},
              {"ref":{"host":"github","owner":"acme","name":"app","number":9},"source":"manual","linkedAt":3}
            ]
            """.trimIndent(),
        )

        assertEquals(
            listOf(
                PrLink(PrLinkRef("github", "acme", "app", 612), "auto", 1, "open", 2),
                PrLink(PrLinkRef("github", "acme", "app", 9), "manual", 3, null, null),
            ),
            RemoteDecoders.prLinks(reply),
        )
        assertEquals(emptyList<PrLink>(), RemoteDecoders.prLinks(JsonNull))
    }

    @Test
    fun `pull-requests unlink decodes ok and refused`() {
        assertEquals(
            PrLinkUnlinkResult.Ok,
            RemoteDecoders.prLinkUnlinkResult(JsonCodec.parse("""{"ok":true}""")),
        )
        assertEquals(
            PrLinkUnlinkResult.Refused("Not linked"),
            RemoteDecoders.prLinkUnlinkResult(JsonCodec.parse("""{"ok":false,"message":"Not linked"}""")),
        )
    }
}
