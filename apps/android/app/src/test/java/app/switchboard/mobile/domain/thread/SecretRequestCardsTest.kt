package app.switchboard.mobile.domain.thread

import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The same cases as tests/unit/secret-request-phone.test.ts. */
class SecretRequestCardsTest {
    @Test
    fun decodesTheCardAndRefusesOneWithoutItsFields() {
        val raw = JsonObject(linkedMapOf("name" to JsonString("KEY_A"), "title" to JsonString("T"), "instructions" to JsonString("I")))
        assertEquals("KEY_A", SecretRequestCards.decode(raw)?.name)
        assertNull(SecretRequestCards.decode(JsonObject(linkedMapOf("name" to JsonString("KEY_A")))))
        assertNull(SecretRequestCards.decode(null))
    }

    @Test
    fun splitsTheHostOutOfTheInstructions() {
        assertEquals(
            listOf(
                SecretInstructionPart.Text("Create it at "),
                SecretInstructionPart.Host("login.tailscale.com", "/admin/settings/keys"),
                SecretInstructionPart.Text(", then Generate auth key."),
            ),
            SecretRequestCards.instructionParts("Create it at https://login.tailscale.com/admin/settings/keys, then Generate auth key."),
        )
        assertEquals(
            SecretInstructionPart.Host("evil.example", "/keys"),
            SecretRequestCards.instructionParts("see https://dashboard.example.com@evil.example/keys.")[1],
        )
        assertEquals(listOf(SecretInstructionPart.Host("localhost:8080", "?x=1")), SecretRequestCards.instructionParts("http://localhost:8080?x=1"))
        assertEquals(
            listOf(SecretInstructionPart.Text("go to http://bad_host.test/x")),
            SecretRequestCards.instructionParts("go to http://bad_host.test/x"),
        )
    }

    @Test
    fun readsTheResultLine() {
        assertEquals("Saved KEY_A", SecretRequestCards.resultLine("Secret KEY_A", "done"))
        assertEquals("Declined KEY_A", SecretRequestCards.resultLine("Secret KEY_A", "dismissed"))
        assertEquals("KEY_A expired", SecretRequestCards.resultLine("Secret KEY_A", "stopped"))
    }
}
