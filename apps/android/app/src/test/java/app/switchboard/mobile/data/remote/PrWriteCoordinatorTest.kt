package app.switchboard.mobile.data.remote

import app.switchboard.mobile.domain.remote.RemoteOutcome
import app.switchboard.mobile.domain.remote.RemoteRequestKey
import app.switchboard.mobile.domain.remote.RemoteResponse
import app.switchboard.mobile.domain.reviews.PhonePrWriteAction
import app.switchboard.mobile.domain.reviews.PhonePrWriteSheet
import app.switchboard.mobile.domain.reviews.PhonePrWrites
import app.switchboard.mobile.domain.reviews.PrComment
import app.switchboard.mobile.domain.reviews.PrConversation
import app.switchboard.mobile.domain.reviews.PrError
import app.switchboard.mobile.domain.reviews.PrPerson
import app.switchboard.mobile.domain.reviews.PrRef
import app.switchboard.mobile.domain.reviews.PrResult
import app.switchboard.mobile.domain.reviews.ReviewEvent
import app.switchboard.mobile.protocol.DisconnectCause
import app.switchboard.mobile.platform.protocol.RpcFailure
import app.switchboard.mobile.platform.protocol.RpcOutcome
import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PrWriteCoordinatorTest {
    private val ref = PrRef("github", "tejasnafde", "switchboard", 161)
    private val thread = PrConversation(
        id = "PRRT_1",
        path = "src/a.ts",
        line = 88,
        startLine = null,
        resolved = false,
        outdated = false,
        comments = listOf(PrComment("1", PrPerson("mira-k", "Mira", null), "Pepper?", 0)),
    )
    private val remote = FakePrWriteRemote()
    private var minted = 0
    private var written = 0

    private fun coordinator(supported: Boolean = true) = PrWriteCoordinator(
        ref = ref,
        supported = supported,
        remote = remote,
        mintWriteId = { "w_test_write_id_${++minted}" },
        onWritten = { written++ },
    )

    /** Opens with the scope granted, threads read and the account known. */
    private fun granted(): PrWriteCoordinator = coordinator().also {
        it.open()
        remote.scopeCalls.last()(ok(listOf("chat", PhonePrWrites.SCOPE)))
        remote.conversationCalls.last()(ok(PrResult.Ok(listOf(thread))))
    }

    private fun replySheet(writes: PrWriteCoordinator, text: String) {
        writes.openComposer(PrWriteTarget.Reply(thread))
        writes.setDraft(text)
        writes.confirmComposer()
        remote.accountCalls.last()(ok(PrResult.Ok("tejasnafde")))
    }

    private fun post(writes: PrWriteCoordinator, auth: PrWriteAuthResult = PrWriteAuthResult.Success) {
        assertTrue(writes.beginPost())
        writes.authFinished(auth)
    }

    @Test
    fun withoutTheCapabilityNothingIsReadOrShown() {
        val writes = coordinator(supported = false)
        writes.open()
        assertTrue(remote.scopeCalls.isEmpty())
        assertTrue(remote.conversationCalls.isEmpty())
        writes.openComposer(PrWriteTarget.Comment)
        writes.resolve(thread)
        assertFalse(writes.state.value.canWrite)
        assertNull(writes.state.value.composer)
        assertNull(writes.state.value.sheet)
    }

    @Test
    fun withoutTheScopeThreadsAreReadOnly() {
        val writes = coordinator()
        writes.open()
        remote.scopeCalls.last()(ok(listOf("chat")))
        remote.conversationCalls.last()(ok(PrResult.Ok(listOf(thread))))
        assertEquals(listOf(thread), writes.state.value.conversations)
        assertFalse(writes.state.value.canWrite)
        writes.openComposer(PrWriteTarget.Reply(thread))
        writes.resolve(thread)
        assertNull(writes.state.value.composer)
        assertNull(writes.state.value.sheet)
        assertTrue(remote.accountCalls.isEmpty())
    }

    @Test
    fun postSendsTheDigestOfExactlyTheShownTrimmedTextWithAValidWriteId() {
        val writes = granted()
        replySheet(writes, "  Fixed in the next commit.\n")
        val sheet = writes.state.value.sheet!!
        assertEquals("Fixed in the next commit.", sheet.text)
        post(writes)
        val write = remote.writes.single()
        assertEquals(PhonePrWriteAction.Reply, write.action)
        val input = write.input.values
        assertEquals(JsonString("PRRT_1"), input["conversationId"])
        assertEquals(JsonString(sheet.text), input["body"])
        val phone = (input.getValue("phone") as JsonObject).values
        val writeId = (phone.getValue("writeId") as JsonString).value
        assertTrue(PhonePrWrites.isWriteId(writeId))
        val expected = PhonePrWrites.digest(
            PhonePrWriteSheet("tejasnafde", ref, PhonePrWriteAction.Reply, "PRRT_1", null, sheet.text, writeId),
        )
        assertEquals(JsonString(expected), phone["shown"])
        assertEquals(PrWritePhase.Posting, writes.state.value.sheet?.phase)
    }

    @Test
    fun okClosesTheSheetClearsTheDraftAndReadsAgain() {
        val writes = granted()
        replySheet(writes, "Done.")
        post(writes)
        remote.writes.single().callback(PrWriteOutcome.Answered(PrResult.Ok(emptyList())))
        val state = writes.state.value
        assertNull(state.sheet)
        assertNull(state.composer)
        assertEquals("", state.draft(PrWriteTarget.Reply(thread)))
        assertEquals("Posted", state.notice)
        assertEquals(2, remote.conversationCalls.size)
        assertEquals(1, written)
    }

    @Test
    fun cancelledAuthenticationSendsNothing() {
        val writes = granted()
        replySheet(writes, "Done.")
        post(writes, PrWriteAuthResult.Cancelled)
        assertTrue(remote.writes.isEmpty())
        assertEquals(PrWritePhase.Ready, writes.state.value.sheet?.phase)
    }

    @Test
    fun noCredentialShowsThePasscodeNoteAndSendsNothing() {
        val writes = granted()
        replySheet(writes, "Done.")
        post(writes, PrWriteAuthResult.NoCredential)
        assertTrue(remote.writes.isEmpty())
        assertEquals(PrWritePhase.NoPasscode, writes.state.value.sheet?.phase)
    }

    @Test
    fun anUncertainWriteIsNeverSentAgain() {
        val writes = granted()
        replySheet(writes, "Done.")
        post(writes)
        remote.writes.single().callback(PrWriteOutcome.Uncertain("Timeout"))
        val sheet = writes.state.value.sheet!!
        assertEquals(PrWritePhase.Uncertain, sheet.phase)
        assertFalse(sheet.canPost)
        assertFalse(writes.beginPost())
        writes.authFinished(PrWriteAuthResult.Success)
        assertEquals(1, remote.writes.size)
        writes.checkThread()
        assertNull(writes.state.value.sheet)
        assertEquals("Done.", writes.state.value.draft(PrWriteTarget.Reply(thread)))
        assertEquals(2, remote.conversationCalls.size)
        assertEquals(1, remote.writes.size)
    }

    @Test
    fun aDeviceCheckThatEndsAfterTheScreenClosedSendsNothing() {
        val writes = granted()
        replySheet(writes, "Done.")
        assertTrue(writes.beginPost())
        writes.close()
        writes.authFinished(PrWriteAuthResult.Success)
        assertTrue(remote.writes.isEmpty())
    }

    @Test
    fun aReconnectKeepsTheDraftAndShowsTheAnswerToAWriteInFlight() {
        val writes = granted()
        replySheet(writes, "Done.")
        post(writes)
        writes.attach(remote = null, supported = false, onWritten = {})
        remote.writes.single().callback(PrWriteOutcome.Uncertain("ConnectionLost"))
        val next = FakePrWriteRemote()
        writes.attach(remote = next, supported = true, onWritten = {})
        writes.open()
        assertEquals(PrWritePhase.Uncertain, writes.state.value.sheet?.phase)
        assertEquals("Done.", writes.state.value.draft(PrWriteTarget.Reply(thread)))
        assertEquals(1, next.scopeCalls.size)
        assertTrue(next.writes.isEmpty())
    }

    @Test
    fun withNoConnectionAPostIsNotSent() {
        val writes = granted()
        replySheet(writes, "Done.")
        assertTrue(writes.beginPost())
        writes.attach(remote = null, supported = true, onWritten = {})
        writes.authFinished(PrWriteAuthResult.Success)
        assertTrue(remote.writes.isEmpty())
        val sheet = writes.state.value.sheet!!
        assertEquals(PrWritePhase.Refused, sheet.phase)
        assertEquals(PrWriteCoordinator.NOT_SENT, sheet.message)
    }

    @Test
    fun aRefusalKeepsTheTextAndPostAgainMintsANewWriteId() {
        val writes = granted()
        replySheet(writes, "Done.")
        post(writes)
        remote.writes.single().callback(PrWriteOutcome.Answered(PrResult.Failed(PrError("invalid", "github", "Thread is locked."))))
        val refused = writes.state.value.sheet!!
        assertEquals(PrWritePhase.Refused, refused.phase)
        assertEquals("Thread is locked.", refused.message)
        assertEquals("Done.", refused.text)
        assertEquals(1, remote.writes.size)
        post(writes)
        assertEquals(2, remote.writes.size)
        val (first, second) = remote.writes.map { ((it.input.values.getValue("phone") as JsonObject).values.getValue("writeId") as JsonString).value }
        assertNotEquals(first, second)
    }

    @Test
    fun notPermittedRemovesTheScopeAndKeepsTheText() {
        val writes = granted()
        replySheet(writes, "Done.")
        post(writes)
        remote.writes.single().callback(PrWriteOutcome.NotPermitted("not permitted: pull-requests:reply"))
        val state = writes.state.value
        assertEquals(PrWritePhase.Removed, state.sheet?.phase)
        assertFalse(state.sheet!!.canPost)
        assertFalse(state.canWrite)
        assertEquals("Done.", state.draft(PrWriteTarget.Reply(thread)))
        assertEquals(2, remote.scopeCalls.size)
        assertFalse(writes.beginPost())
    }

    @Test
    fun resolveSendsNoBodyAndAReviewSendsNoLineComments() {
        val writes = granted()
        writes.resolve(thread)
        remote.accountCalls.last()(ok(PrResult.Ok("tejasnafde")))
        post(writes)
        val resolve = remote.writes.single()
        assertEquals(setOf("conversationId", "phone"), resolve.input.values.keys)
        resolve.callback(PrWriteOutcome.Answered(PrResult.Ok(emptyList())))
        assertEquals("Resolved", writes.state.value.notice)

        writes.openComposer(PrWriteTarget.Review(ReviewEvent.Approve))
        writes.confirmComposer()
        remote.accountCalls.last()(ok(PrResult.Ok("tejasnafde")))
        post(writes)
        val review = remote.writes.last().input.values
        assertEquals(JsonString("approve"), review["event"])
        assertEquals(JsonString(""), review["body"])
        assertEquals(JsonArray(emptyList()), review["comments"])
    }

    @Test
    fun postWaitsForTheAccountAndAnEmptyComposerCannotConfirm() {
        val writes = granted()
        writes.openComposer(PrWriteTarget.Comment)
        writes.setDraft("   ")
        writes.confirmComposer()
        assertNull(writes.state.value.sheet)
        writes.setDraft("Hi")
        writes.confirmComposer()
        assertFalse("no account yet", writes.beginPost())
        writes.setReviewEvent(ReviewEvent.Approve)
        assertEquals(PrWriteTarget.Comment, writes.state.value.composer)
    }

    @Test
    fun transportFailuresAreClassified() {
        assertEquals(
            PrWriteOutcome.NotPermitted("not permitted: pull-requests:reply"),
            PrWriteOutcomes.classify(RpcOutcome.Failure(RpcFailure.Remote("not permitted: pull-requests:reply"))),
        )
        assertTrue(PrWriteOutcomes.classify(RpcOutcome.Failure(RpcFailure.Remote("boom"))) is PrWriteOutcome.Uncertain)
        assertTrue(PrWriteOutcomes.classify(RpcOutcome.Failure(RpcFailure.Timeout)) is PrWriteOutcome.Uncertain)
        assertTrue(
            PrWriteOutcomes.classify(RpcOutcome.Failure(RpcFailure.ConnectionLost(DisconnectCause.Network))) is PrWriteOutcome.Uncertain,
        )
        assertTrue(PrWriteOutcomes.classify(RpcOutcome.Failure(RpcFailure.NotReady)) is PrWriteOutcome.NotSent)
        assertTrue(PrWriteOutcomes.classify(RpcOutcome.Success(JsonString("odd"))) is PrWriteOutcome.Uncertain)
        assertEquals(
            PrWriteOutcome.Answered(PrResult.Ok(listOf("detail"))),
            PrWriteOutcomes.classify(
                RpcOutcome.Success(
                    JsonObject(
                        linkedMapOf(
                            "ok" to JsonBoolean(true),
                            "data" to JsonObject(linkedMapOf("refresh" to JsonArray(listOf(JsonString("detail"))))),
                        ),
                    ),
                ),
            ),
        )
    }

    private fun <T> ok(value: T) = RemoteResponse(RemoteRequestKey("machine", 1, "op"), RemoteOutcome.Success(value))
}

internal class FakePrWriteRemote : PrWriteRemote {
    data class Write(val action: PhonePrWriteAction, val input: JsonObject, val callback: (PrWriteOutcome) -> Unit)

    val scopeCalls = mutableListOf<(RemoteResponse<List<String>>) -> Unit>()
    val conversationCalls = mutableListOf<(RemoteResponse<PrResult<List<PrConversation>>>) -> Unit>()
    val accountCalls = mutableListOf<(RemoteResponse<PrResult<String>>) -> Unit>()
    val writes = mutableListOf<Write>()

    override fun scopes(callback: (RemoteResponse<List<String>>) -> Unit) {
        scopeCalls += callback
    }

    override fun conversations(ref: PrRef, callback: (RemoteResponse<PrResult<List<PrConversation>>>) -> Unit) {
        conversationCalls += callback
    }

    override fun writeAccount(ref: PrRef, callback: (RemoteResponse<PrResult<String>>) -> Unit) {
        accountCalls += callback
    }

    override fun write(action: PhonePrWriteAction, ref: PrRef, input: JsonObject, callback: (PrWriteOutcome) -> Unit) {
        writes += Write(action, input, callback)
    }
}
