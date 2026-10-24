package app.switchboard.mobile.data.remote

import app.switchboard.mobile.domain.remote.RemoteOutcome
import app.switchboard.mobile.domain.remote.RemoteResponse
import app.switchboard.mobile.domain.reviews.PhonePrWriteAction
import app.switchboard.mobile.domain.reviews.PhonePrWriteSheet
import app.switchboard.mobile.domain.reviews.PhonePrWrites
import app.switchboard.mobile.domain.reviews.PrConversation
import app.switchboard.mobile.domain.reviews.PrRef
import app.switchboard.mobile.domain.reviews.PrResult
import app.switchboard.mobile.domain.reviews.PullRequestDecoders
import app.switchboard.mobile.domain.reviews.ReviewEvent
import app.switchboard.mobile.platform.protocol.RpcFailure
import app.switchboard.mobile.platform.protocol.RpcOutcome
import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** What became of one write. Only [Answered] and [NotSent] are certain. */
sealed interface PrWriteOutcome {
    /** The backend answered: posted, or a definite refusal. */
    data class Answered(val result: PrResult<List<String>>) : PrWriteOutcome

    /** Rejected with 'not permitted': the desktop removed the scope. */
    data class NotPermitted(val message: String) : PrWriteOutcome

    /** Never left the phone. */
    data class NotSent(val reason: String) : PrWriteOutcome

    /** May have reached the host (timeout, disconnect, a thrown handler). */
    data class Uncertain(val reason: String) : PrWriteOutcome
}

object PrWriteOutcomes {
    fun classify(outcome: RpcOutcome): PrWriteOutcome = when (outcome) {
        is RpcOutcome.Success -> try {
            PrWriteOutcome.Answered(PullRequestDecoders.writeResult(outcome.result))
        } catch (error: RuntimeException) {
            // The backend answered, so the write may have gone through.
            PrWriteOutcome.Uncertain(error.message ?: "Malformed response")
        }
        is RpcOutcome.Failure -> when (val reason = outcome.reason) {
            is RpcFailure.Remote ->
                if (reason.error.startsWith(PhonePrWrites.NOT_PERMITTED_PREFIX)) {
                    PrWriteOutcome.NotPermitted(reason.error)
                } else {
                    PrWriteOutcome.Uncertain(reason.error)
                }
            // Both are refused before the frame is sent.
            RpcFailure.NotReady, RpcFailure.CapacityExceeded -> PrWriteOutcome.NotSent(reason.toString())
            else -> PrWriteOutcome.Uncertain(reason.toString())
        }
    }
}

interface PrWriteRemote {
    fun scopes(callback: (RemoteResponse<List<String>>) -> Unit)
    fun conversations(ref: PrRef, callback: (RemoteResponse<PrResult<List<PrConversation>>>) -> Unit)
    fun writeAccount(ref: PrRef, callback: (RemoteResponse<PrResult<String>>) -> Unit)
    fun write(action: PhonePrWriteAction, ref: PrRef, input: JsonObject, callback: (PrWriteOutcome) -> Unit)
}

class SwitchboardPrWriteRemote(private val client: SwitchboardRemoteClient) : PrWriteRemote {
    override fun scopes(callback: (RemoteResponse<List<String>>) -> Unit) = client.deviceScopes(callback).let { }

    override fun conversations(ref: PrRef, callback: (RemoteResponse<PrResult<List<PrConversation>>>) -> Unit) =
        client.pullRequestConversations(ref, callback).let { }

    override fun writeAccount(ref: PrRef, callback: (RemoteResponse<PrResult<String>>) -> Unit) =
        client.pullRequestWriteAccount(ref, callback).let { }

    override fun write(action: PhonePrWriteAction, ref: PrRef, input: JsonObject, callback: (PrWriteOutcome) -> Unit) =
        client.pullRequestWrite(action, ref, input, callback)
}

/** What a composer or sheet writes to. */
sealed interface PrWriteTarget {
    val action: PhonePrWriteAction

    /** Where the composer text is kept; null for resolve, which has no text. */
    val draftKey: String?

    data class Reply(override val conversation: PrConversation) : PrWriteTarget {
        override val action get() = PhonePrWriteAction.Reply
        override val draftKey get() = "reply:${conversation.id}"
    }

    data class Resolve(override val conversation: PrConversation) : PrWriteTarget {
        override val action get() = PhonePrWriteAction.Resolve
        override val draftKey: String? get() = null
    }

    data object Comment : PrWriteTarget {
        override val action get() = PhonePrWriteAction.Comment
        override val draftKey get() = "comment"
    }

    data class Review(override val event: ReviewEvent) : PrWriteTarget {
        override val action get() = PhonePrWriteAction.Review
        override val draftKey get() = "review"
    }

    /** The thread of a reply or resolve. */
    val conversation: PrConversation? get() = null

    /** The verdict of a review. */
    val event: ReviewEvent? get() = null
}

enum class PrWritePhase { Ready, Authenticating, Posting, Refused, Removed, Uncertain, NoPasscode }

data class PrWriteSheetState(
    val target: PrWriteTarget,
    /** Trimmed once when the sheet opened; shown, digested and sent as is. */
    val text: String,
    val account: String? = null,
    val accountError: String? = null,
    val phase: PrWritePhase = PrWritePhase.Ready,
    /** The refusal to show in [PrWritePhase.Refused]. */
    val message: String? = null,
) {
    val canPost: Boolean
        get() = account != null &&
            (phase == PrWritePhase.Ready || phase == PrWritePhase.Refused || phase == PrWritePhase.NoPasscode)
}

data class PrWriteState(
    /** The backend advertises [PhonePrWrites.CAPABILITY]. Without it nothing shows. */
    val supported: Boolean,
    /** The last scopes read; null until one answers. */
    val scopes: List<String>? = null,
    val conversations: List<PrConversation>? = null,
    val conversationsError: String? = null,
    val drafts: Map<String, String> = emptyMap(),
    /** The open composer: reply, comment or review. */
    val composer: PrWriteTarget? = null,
    val sheet: PrWriteSheetState? = null,
    /** A short confirmation after a write ("Posted"). */
    val notice: String? = null,
) {
    val canWrite: Boolean get() = supported && scopes?.contains(PhonePrWrites.SCOPE) == true

    fun draft(target: PrWriteTarget): String = target.draftKey?.let { drafts[it] }.orEmpty()
}

/** The result of the device check the UI runs on Post. */
sealed interface PrWriteAuthResult {
    data object Success : PrWriteAuthResult
    data object Cancelled : PrWriteAuthResult
    data object NoCredential : PrWriteAuthResult
    data class Failed(val message: String) : PrWriteAuthResult
}

/**
 * Phone writes on one pull request. Every Post asks the UI for a device check
 * first, then sends the write once with a fresh write id and the digest of
 * exactly what the sheet showed. Nothing is queued, retried or re-sent: an
 * uncertain write leaves only "Check thread".
 */
class PrWriteCoordinator(
    val ref: PrRef,
    supported: Boolean,
    private val remote: PrWriteRemote,
    private val mintWriteId: () -> String = { PhonePrWrites.mintWriteId() },
    /** Re-reads the pull request detail after a write. */
    private val onWritten: () -> Unit = {},
    private val log: (String) -> Unit = {},
) {
    private val mutableState = MutableStateFlow(PrWriteState(supported = supported))
    val state: StateFlow<PrWriteState> = mutableState.asStateFlow()

    private var scopesRequest = 0L
    private var conversationsRequest = 0L
    private var accountRequest = 0L
    private var phaseBeforeAuth = PrWritePhase.Ready

    private var value: PrWriteState
        get() = mutableState.value
        set(next) {
            mutableState.value = next
        }

    /** The screen opened or came back to the front. */
    @Synchronized
    fun open() {
        refreshScopes()
        loadConversations()
    }

    @Synchronized
    fun refreshScopes() {
        if (!value.supported) return
        val id = ++scopesRequest
        remote.scopes { response ->
            synchronized(this) {
                if (id != scopesRequest) return@scopes
                when (val outcome = response.outcome) {
                    is RemoteOutcome.Success -> value = value.copy(scopes = outcome.value)
                    is RemoteOutcome.Failure -> log("device-session:scopes failed: ${outcome.message}")
                }
            }
        }
    }

    @Synchronized
    fun loadConversations() {
        if (!value.supported) return
        val id = ++conversationsRequest
        remote.conversations(ref) { response ->
            synchronized(this) {
                if (id != conversationsRequest) return@conversations
                val failure = when (val outcome = response.outcome) {
                    is RemoteOutcome.Failure -> outcome.message
                    is RemoteOutcome.Success -> when (val result = outcome.value) {
                        is PrResult.Failed -> result.error.message
                        is PrResult.Ok -> {
                            value = value.copy(conversations = result.data, conversationsError = null)
                            null
                        }
                    }
                }
                if (failure != null) {
                    log("pull-requests:conversations failed: $failure")
                    value = value.copy(conversationsError = failure)
                }
            }
        }
    }

    @Synchronized
    fun openComposer(target: PrWriteTarget) {
        if (!value.canWrite || target is PrWriteTarget.Resolve) return
        value = value.copy(composer = target)
    }

    @Synchronized
    fun closeComposer() {
        value = value.copy(composer = null)
    }

    @Synchronized
    fun setDraft(text: String) {
        val key = value.composer?.draftKey ?: return
        value = value.copy(drafts = value.drafts + (key to text))
    }

    @Synchronized
    fun setReviewEvent(event: ReviewEvent) {
        if (value.composer !is PrWriteTarget.Review) return
        value = value.copy(composer = PrWriteTarget.Review(event))
    }

    /** Opens the confirm sheet for the composer's text, trimmed once. */
    @Synchronized
    fun confirmComposer() {
        val target = value.composer ?: return
        val text = value.draft(target).trim()
        if (PrWriteRules.composerProblem(ref.host, target, text) != null) return
        openSheet(target, text)
    }

    @Synchronized
    fun resolve(conversation: PrConversation) {
        openSheet(PrWriteTarget.Resolve(conversation), "")
    }

    private fun openSheet(target: PrWriteTarget, text: String) {
        if (!value.canWrite) return
        value = value.copy(sheet = PrWriteSheetState(target, text))
        val id = ++accountRequest
        remote.writeAccount(ref) { response ->
            synchronized(this) {
                if (id != accountRequest) return@writeAccount
                val sheet = value.sheet ?: return@writeAccount
                val next = when (val outcome = response.outcome) {
                    is RemoteOutcome.Failure -> sheet.copy(accountError = outcome.message)
                    is RemoteOutcome.Success -> when (val result = outcome.value) {
                        is PrResult.Failed -> sheet.copy(accountError = result.error.message)
                        is PrResult.Ok -> sheet.copy(account = result.data, accountError = null)
                    }
                }
                if (next.accountError != null) log("pull-requests:write-account failed: ${next.accountError}")
                value = value.copy(sheet = next)
            }
        }
    }

    /** Cancel, or a swipe down. A sheet that is checking or posting stays open. */
    @Synchronized
    fun dismissSheet() {
        val phase = value.sheet?.phase ?: return
        if (phase == PrWritePhase.Authenticating || phase == PrWritePhase.Posting) return
        accountRequest++
        value = value.copy(sheet = null)
    }

    /** Post tapped: true when the UI should run the device check now. */
    @Synchronized
    fun beginPost(): Boolean {
        val sheet = value.sheet ?: return false
        if (!sheet.canPost || !value.canWrite) return false
        phaseBeforeAuth = sheet.phase
        value = value.copy(sheet = sheet.copy(phase = PrWritePhase.Authenticating))
        return true
    }

    @Synchronized
    fun authFinished(result: PrWriteAuthResult) {
        val sheet = value.sheet ?: return
        if (sheet.phase != PrWritePhase.Authenticating) return
        value = when (result) {
            PrWriteAuthResult.Success -> {
                send(sheet)
                return
            }
            PrWriteAuthResult.Cancelled -> value.copy(sheet = sheet.copy(phase = phaseBeforeAuth))
            PrWriteAuthResult.NoCredential -> value.copy(sheet = sheet.copy(phase = PrWritePhase.NoPasscode, message = null))
            is PrWriteAuthResult.Failed -> value.copy(
                sheet = sheet.copy(phase = PrWritePhase.Refused, message = "${result.message} Nothing was sent."),
            )
        }
    }

    private fun send(sheet: PrWriteSheetState) {
        val account = sheet.account ?: return
        val writeId = mintWriteId()
        val target = sheet.target
        val shown = PhonePrWrites.digest(
            PhonePrWriteSheet(
                account = account,
                ref = ref,
                action = target.action,
                conversationId = target.conversation?.id,
                event = target.event,
                text = sheet.text,
                writeId = writeId,
            ),
        )
        value = value.copy(sheet = sheet.copy(phase = PrWritePhase.Posting, message = null))
        remote.write(target.action, ref, PrWriteRules.input(target, sheet.text, shown, writeId)) { outcome ->
            synchronized(this) { finish(sheet, outcome) }
        }
    }

    private fun finish(sent: PrWriteSheetState, outcome: PrWriteOutcome) {
        val current = value.sheet?.takeIf { it.target == sent.target && it.phase == PrWritePhase.Posting }
        when (outcome) {
            is PrWriteOutcome.Answered -> when (val result = outcome.result) {
                is PrResult.Ok -> {
                    val key = sent.target.draftKey
                    value = value.copy(
                        sheet = null,
                        composer = null,
                        drafts = if (key == null) value.drafts else value.drafts - key,
                        notice = PrWriteRules.doneNotice(sent.target),
                    )
                    loadConversations()
                    onWritten()
                }
                is PrResult.Failed -> {
                    log("pull request write refused: ${result.error.message}")
                    if (current != null) {
                        value = value.copy(sheet = current.copy(phase = PrWritePhase.Refused, message = result.error.message))
                    }
                }
            }
            is PrWriteOutcome.NotPermitted -> {
                log("pull request write not permitted: ${outcome.message}")
                value = value.copy(
                    scopes = value.scopes?.minus(PhonePrWrites.SCOPE),
                    composer = null,
                    sheet = current?.copy(phase = PrWritePhase.Removed, message = null),
                )
                refreshScopes()
            }
            is PrWriteOutcome.NotSent -> {
                log("pull request write not sent: ${outcome.reason}")
                if (current != null) {
                    value = value.copy(sheet = current.copy(phase = PrWritePhase.Refused, message = NOT_SENT))
                }
            }
            is PrWriteOutcome.Uncertain -> {
                log("pull request write uncertain: ${outcome.reason}")
                if (current != null) value = value.copy(sheet = current.copy(phase = PrWritePhase.Uncertain, message = null))
            }
        }
    }

    /** "Check thread" on an uncertain sheet: re-read the threads and close it. The draft stays. */
    @Synchronized
    fun checkThread() {
        if (value.sheet?.phase != PrWritePhase.Uncertain) return
        value = value.copy(sheet = null)
        loadConversations()
        onWritten()
    }

    @Synchronized
    fun clearNotice() {
        value = value.copy(notice = null)
    }

    companion object {
        const val NOT_SENT = "Not connected to the computer. Nothing was sent."
    }
}

/** Pure rules the composer, the sheet and the coordinator share. */
object PrWriteRules {
    /** Why the composer cannot post [text] (already trimmed), or null. */
    fun composerProblem(host: String, target: PrWriteTarget, text: String): String? = when (target) {
        is PrWriteTarget.Review -> PhonePrWrites.reviewSubmitProblem(host, target.event, text)
        is PrWriteTarget.Resolve -> null
        else -> when {
            text.isEmpty() -> "Write something first."
            text.length > PhonePrWrites.TEXT_MAX_CHARS -> "The text is too long."
            else -> null
        }
    }

    /** The write's input object, `phone` proof included. */
    fun input(target: PrWriteTarget, text: String, shown: String, writeId: String): JsonObject {
        val fields = linkedMapOf<String, JsonValue>()
        target.conversation?.let { fields["conversationId"] = JsonString(it.id) }
        target.event?.let { fields["event"] = JsonString(it.wire) }
        if (target !is PrWriteTarget.Resolve) fields["body"] = JsonString(text)
        if (target is PrWriteTarget.Review) fields["comments"] = JsonArray(emptyList())
        fields["phone"] = JsonObject(linkedMapOf("shown" to JsonString(shown), "writeId" to JsonString(writeId)))
        return JsonObject(fields)
    }

    fun sheetTitle(target: PrWriteTarget): String = when (target) {
        is PrWriteTarget.Reply -> "Post this reply?"
        is PrWriteTarget.Resolve -> "Resolve this thread?"
        PrWriteTarget.Comment -> "Post this comment?"
        is PrWriteTarget.Review -> when (target.event) {
            ReviewEvent.Approve -> "Approve pull request?"
            ReviewEvent.RequestChanges -> "Request changes?"
            ReviewEvent.Comment -> "Post this review?"
        }
    }

    fun primaryLabel(target: PrWriteTarget): String = when (target) {
        is PrWriteTarget.Reply -> "Post reply"
        is PrWriteTarget.Resolve -> "Resolve"
        PrWriteTarget.Comment -> "Post comment"
        is PrWriteTarget.Review -> target.event.label
    }

    fun doneNotice(target: PrWriteTarget): String = when (target) {
        is PrWriteTarget.Resolve -> "Resolved"
        is PrWriteTarget.Review -> when (target.event) {
            ReviewEvent.Approve -> "Approved"
            ReviewEvent.RequestChanges -> "Changes requested"
            ReviewEvent.Comment -> "Review posted"
        }
        else -> "Posted"
    }
}
