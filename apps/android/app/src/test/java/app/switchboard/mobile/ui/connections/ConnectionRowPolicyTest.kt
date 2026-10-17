package app.switchboard.mobile.ui.connections

import app.switchboard.mobile.domain.connection.ConnectionSecurity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ConnectionRowPolicyTest {
    @Test
    fun rowsTheUserMustFixMoveToNeedsAttentionWithoutReordering() {
        val rows = listOf(
            row(ConnectionStatus.OFFLINE).copy(id = "offline"),
            row(ConnectionStatus.ERROR, security = ConnectionSecurity.REFUSED).copy(id = "refused"),
            row(ConnectionStatus.LIVE, security = ConnectionSecurity.PINNED).copy(id = "live"),
            row(ConnectionStatus.ERROR, security = ConnectionSecurity.CERTIFICATE_CHANGED).copy(id = "changed"),
            row(ConnectionStatus.CONNECTING).copy(id = "connecting"),
            row(ConnectionStatus.ERROR).copy(id = "error"),
        )

        val sections = ConnectionsListPolicy.sections(rows)
        assertEquals(listOf("offline", "live", "connecting"), sections.live.map { it.id })
        assertEquals(listOf("refused", "changed", "error"), sections.attention.map { it.id })
    }

    @Test
    fun statusDetailSaysWhyUnlessTheSecurityHintAlreadyDoes() {
        assertEquals("Token rejected", ConnectionsListPolicy.statusDetail(row(ConnectionStatus.ERROR, "Token rejected")))
        assertNull(ConnectionsListPolicy.statusDetail(row(ConnectionStatus.LIVE, "ignored")))
        assertNull(ConnectionsListPolicy.statusDetail(row(ConnectionStatus.OFFLINE, " ")))
        assertNull(
            ConnectionsListPolicy.statusDetail(
                row(ConnectionStatus.ERROR, "This build needs an encrypted connection", ConnectionSecurity.REFUSED),
            ),
        )
        assertNull(
            ConnectionsListPolicy.statusDetail(
                row(ConnectionStatus.ERROR, "certificate changed", ConnectionSecurity.CERTIFICATE_CHANGED),
            ),
        )
    }

    private fun row(
        status: ConnectionStatus,
        detail: String? = null,
        security: ConnectionSecurity = ConnectionSecurity.PLAIN,
    ) = ConnectionRowPresentation(
        id = "studio",
        label = "Studio",
        kind = ConnectionKind.WEBSOCKET,
        target = "studio.local:8765",
        status = status,
        statusLabel = status.name.lowercase(),
        live = status == ConnectionStatus.LIVE,
        showProgress = status == ConnectionStatus.CONNECTING,
        detail = detail,
        security = security,
    )
}
