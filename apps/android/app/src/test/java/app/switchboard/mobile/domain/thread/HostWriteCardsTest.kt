package app.switchboard.mobile.domain.thread

import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HostWriteCardsTest {
    @Test
    fun replyNamesItsActionsWithThePrimaryTheAgentSuggested() {
        val card = card("action" to s("reply"), "suggestResolve" to JsonBoolean(true))!!
        assertEquals("Reply and resolve a review conversation", HostWriteCards.title(card))
        assertEquals("GitHub · app #612 · sync/worker.py:88", HostWriteCards.context(card))
        assertEquals(
            listOf(
                Triple("Post reply", false, HostWriteResponse(resolve = false)),
                Triple("Post and resolve", true, HostWriteResponse(resolve = true)),
            ),
            HostWriteCards.buttons(card).map { Triple(it.label, it.primary, it.response) },
        )
    }

    @Test
    fun everyOtherWriteHasOneActionNamedPrimaryButton() {
        val labels = listOf("comment", "resolve", "rerun", "create").map { action ->
            HostWriteCards.buttons(card("action" to s(action))!!).single().let { it.label to it.primary }
        }
        assertEquals(
            listOf("Post comment" to true, "Resolve" to true, "Re-run" to true, "Open pull request" to true),
            labels,
        )
        val draft = card("action" to s("create"), "create" to obj("draft" to JsonBoolean(true)))!!
        assertEquals("Open draft", HostWriteCards.buttons(draft).single().label)
    }

    @Test
    fun reviewOffersOnlyTheListedVerdictsNoneOfThemPrimary() {
        val review = card(
            "action" to s("review"),
            "review" to obj(
                "summary" to s(""),
                "comments" to JsonArray(listOf(obj("text" to s("Log it.")))),
                "verdicts" to JsonArray(listOf(s("comment"), s("approve"), s("request_changes"))),
            ),
        )!!
        val buttons = HostWriteCards.buttons(review)
        assertEquals(listOf("Comment", "Request changes", "Approve"), buttons.map { it.label })
        assertEquals(listOf(false, false, false), buttons.map { it.primary })
        assertEquals(HostWriteResponse(verdict = "request_changes"), buttons[1].response)
        assertEquals("GitHub needs a summary to request changes.", buttons[1].problem)
        assertNull(buttons[0].problem)

        val own = card(
            "action" to s("review"),
            "review" to obj("summary" to s("ok"), "verdicts" to JsonArray(listOf(s("comment")))),
        )!!
        assertEquals(listOf("Comment"), HostWriteCards.buttons(own).map { it.label })
    }

    // Cross-implementation vectors, pinned with the same cards in tests/unit/mobile-approval-actions.test.ts.
    private val replyVector = obj(
        "action" to s("reply"), "host" to s("github"), "prLabel" to s("app #612"),
        "target" to obj("repository" to s("acme/app"), "number" to JsonNumber("612")),
        "location" to s("a.ts:3"), "quote" to obj("author" to s("rév"), "body" to s("Why? 🙂")),
        "replyText" to s("Because.\nSee a.ts."),
    )
    private val createVector = obj(
        "action" to s("create"), "host" to s("bitbucket"), "prLabel" to s("acme/app"),
        "target" to obj("repository" to s("acme/app"), "number" to JsonNull),
        "create" to obj(
            "repoLabel" to s("acme/app"), "sourceBranch" to s("feat/x"), "targetBranch" to s("main"),
            "title" to s("Add it"), "description" to s("Line one.\nLine two."), "draft" to JsonBoolean(false),
        ),
    )

    private fun reviewer(id: String, login: String, displayName: String, kind: String) =
        obj("id" to s(id), "login" to s(login), "displayName" to s(displayName), "kind" to s(kind))
    private val reviewersVector = obj(
        "action" to s("create"), "host" to s("github"), "prLabel" to s("acme/app"),
        "target" to obj("repository" to s("acme/app"), "number" to JsonNull),
        "create" to obj(
            "repoLabel" to s("acme/app"), "sourceBranch" to s("feat/x"), "targetBranch" to s("main"),
            "title" to s("Add it"), "description" to s("Line one."), "draft" to JsonBoolean(false),
            "reviewers" to JsonArray(
                listOf(
                    reviewer("jdoe", "jdoe", "Jane Doé", "user"),
                    reviewer("team:platform", "team:platform", "platform", "team"),
                    reviewer("rk", "rk", "rk", "user"),
                ),
            ),
        ),
    )

    @Test
    fun shownDigestMatchesTheSharedVectors() {
        assertEquals("d3cf5b181c2a5b68", HostWriteCards.shownDigest("sbmcp_42", HostWriteCards.decode(replyVector)!!))
        assertEquals("fa05a2aef032d27a", HostWriteCards.shownDigest("sbmcp_43", HostWriteCards.decode(createVector)!!))
        assertEquals("3dc4b25b5a5e1bd1", HostWriteCards.shownDigest("sbmcp_44", HostWriteCards.decode(reviewersVector)!!))
    }

    @Test
    fun previewAndDigestCoverACreatesReviewers() {
        val preview = HostWriteCards.preview(HostWriteCards.decode(reviewersVector)!!)!!
        assertEquals(HostWritePreviewSection("Reviewers", "Jane Doé (jdoe)\nplatform (team:platform)\nrk"), preview.sections.last())
        val create = reviewersVector.values["create"] as JsonObject
        fun withReviewers(value: JsonValue?) = JsonObject(
            LinkedHashMap(reviewersVector.values).apply {
                put("create", JsonObject(LinkedHashMap(create.values).apply { if (value == null) remove("reviewers") else put("reviewers", value) }))
            },
        )
        val base = HostWriteCards.shownDigest("sbmcp_44", HostWriteCards.decode(reviewersVector)!!)
        val fewer = withReviewers(JsonArray(listOf(reviewer("rk", "rk", "rk", "user"))))
        assertNotEquals(base, HostWriteCards.shownDigest("sbmcp_44", HostWriteCards.decode(fewer)!!))
        assertNotEquals(base, HostWriteCards.shownDigest("sbmcp_44", HostWriteCards.decode(withReviewers(null))!!))
        val broken = withReviewers(JsonArray(listOf(obj("id" to s("x")))))
        assertNull(HostWriteCards.preview(HostWriteCards.decode(broken)!!))
        assertNull(HostWriteCards.shownDigest("sbmcp_44", HostWriteCards.decode(broken)!!))
    }

    @Test
    fun shownDigestDoesNotMatchTheSameTextOnAnotherCardOrPullRequest() {
        val base = HostWriteCards.shownDigest("sbmcp_42", HostWriteCards.decode(replyVector)!!)
        assertNotEquals(base, HostWriteCards.shownDigest("sbmcp_99", HostWriteCards.decode(replyVector)!!))
        val otherPr = JsonObject(LinkedHashMap(replyVector.values).apply { put("target", obj("repository" to s("acme/app"), "number" to JsonNumber("613"))) })
        assertNotEquals(base, HostWriteCards.shownDigest("sbmcp_42", HostWriteCards.decode(otherPr)!!))
        val noTarget = JsonObject(LinkedHashMap(replyVector.values).apply { remove("target") })
        assertNull(HostWriteCards.shownDigest("sbmcp_42", HostWriteCards.decode(noTarget)!!))
        assertNull(HostWriteCards.shownDigest("sbmcp_42", card("action" to s("reply"))!!))
    }

    @Test
    fun responseEncodesOnlyWhatItCarries() {
        assertEquals("""{"resolve":true,"shown":"00ff"}""", JsonCodec.encode(HostWriteResponse(resolve = true, shown = "00ff").toJson()))
        assertEquals("""{"verdict":"comment"}""", JsonCodec.encode(HostWriteResponse(verdict = "comment").toJson()))
        assertEquals("""{"resolve":false}""", JsonCodec.encode(HostWriteResponse(resolve = false).toJson()))
        assertEquals("""{"verdict":"comment","quiet":true}""", JsonCodec.encode(HostWriteResponse(verdict = "comment", quiet = true).toJson()))
    }

    @Test
    fun decodeIgnoresAMissingOrUnusableCard() {
        assertNull(HostWriteCards.decode(null))
        assertNull(HostWriteCards.decode(s("reply")))
        assertNull(HostWriteCards.decode(obj("host" to s("github"))))
    }

    @Test
    fun previewHoldsEveryWordAReviewPostsUnderItsPlace() {
        val text = "y".repeat(2_000)
        val review = card(
            "action" to s("review"),
            "review" to obj(
                "summary" to s("Sum."),
                "comments" to JsonArray(listOf(obj("path" to s("a.ts"), "side" to s("old"), "line" to JsonNumber("9"), "startLine" to JsonNumber("4"), "text" to s(text)))),
                "verdicts" to JsonArray(listOf(s("comment"))),
            ),
        )!!
        assertEquals(
            HostWritePreview(listOf(HostWritePreviewSection("Summary", "Sum."), HostWritePreviewSection("a.ts:4-9 (old)", text)), long = true),
            HostWriteCards.preview(review),
        )
    }

    @Test
    fun previewShowsATitleTheWholeDescriptionAndTheQuotedComment() {
        val description = "d".repeat(900)
        val create = card(
            "action" to s("create"),
            "create" to obj("repoLabel" to s("acme/app"), "sourceBranch" to s("feat"), "targetBranch" to s("main"), "title" to s("Add it"), "description" to s(description)),
        )!!
        assertEquals(
            listOf("Branches" to "acme/app: feat -> main", "Title" to "Add it", "Description" to description),
            HostWriteCards.preview(create)!!.sections.map { it.label to it.text },
        )
        val reply = card("action" to s("reply"), "replyText" to s("Done."), "quote" to obj("author" to s("rev"), "body" to s("Why?")))!!
        assertEquals(
            HostWritePreview(listOf(HostWritePreviewSection("rev wrote", "Why?"), HostWritePreviewSection("Reply", "Done.")), long = false),
            HostWriteCards.preview(reply),
        )
    }

    @Test
    fun previewIsNullWhenThePayloadLacksWhatTheApprovalWouldPost() {
        assertNull(HostWriteCards.preview(card("action" to s("reply"))!!))
        assertNull(HostWriteCards.preview(card("action" to s("review"), "review" to obj("summary" to s("x")))!!))
        assertNull(HostWriteCards.preview(card("action" to s("create"))!!))
        assertNull(HostWriteCards.preview(card("action" to s("merge"))!!))
    }

    private fun card(vararg fields: Pair<String, JsonValue>): HostWriteCard? = HostWriteCards.decode(
        obj("host" to s("github"), "prLabel" to s("app #612"), "location" to s("sync/worker.py:88"), *fields),
    )

    private fun s(value: String) = JsonString(value)
    private fun obj(vararg fields: Pair<String, JsonValue>) = JsonObject(linkedMapOf(*fields))
}
