package app.switchboard.mobile.domain.reviews

import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue
import java.nio.file.Files
import java.nio.file.Path
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Runs every section of tests/fixtures/phone-pr-cases.json, which
 * tests/unit/pull-request-phone.test.ts writes from the TypeScript rules,
 * against the Kotlin port in [PhonePullRequests].
 */
class PhonePullRequestsFixtureTest {
    private val fixture = loadFixture() as JsonObject
    private val now = (fixture.values.getValue("now") as JsonNumber).source.toLong()
    private val prs: Map<String, PrSummary> = (fixture.values.getValue("prs") as JsonObject).values
        .mapValues { (_, value) -> PullRequestDecoders.summary(value) }
    private val all = prs.values.toList()
    private val hidden = fixture.array("hidden").map { (it as JsonString).value }

    @Test
    fun rowStatus() {
        val cases = fixture.array("rowStatus")
        assertEquals(prs.size, cases.size)
        cases.map { it as JsonObject }.forEach { case ->
            val id = case.str("pr")
            val actual = PhonePullRequests.rowStatus(prs.getValue(id), now)
            when (val expected = case.values.getValue("expected")) {
                JsonNull -> assertNull(id, actual)
                is JsonObject -> {
                    assertEquals(id, expected.str("group"), actual?.group?.wire)
                    assertEquals(id, expected.str("icon"), actual?.icon?.wire)
                    assertEquals(id, expected.str("phrase"), actual?.phrase)
                }
                else -> error("bad rowStatus case $id")
            }
        }
    }

    @Test
    fun filtersAndActive() {
        val cases = fixture.array("filters").map { it as JsonObject }
        assertTrue(cases.isNotEmpty())
        cases.forEach { case ->
            val id = case.str("id")
            val filters = decodeFilters(case.obj("filters"))
            assertEquals(id, (case.values.getValue("active") as JsonBoolean).value, PhonePullRequests.filtersActive(filters))
            assertEquals(
                id,
                case.array("expected").map { (it as JsonString).value },
                PhonePullRequests.filter(all, hidden, filters, case.str("query"), now).map { it.ref.key },
            )
        }
    }

    @Test
    fun needsYou() {
        assertEquals(
            (fixture.values.getValue("needsYou") as JsonNumber).source.toInt(),
            PhonePullRequests.needsYouCount(all, hidden, now),
        )
    }

    @Test
    fun sections() {
        val shown = PhonePullRequests.filter(all, emptyList(), PhonePullRequests.DEFAULT_FILTERS, "", now)
        fixture.array("sections").map { it as JsonObject }.forEach { case ->
            val groupBy = PhonePrGroupBy.entries.single { it.wire == case.str("groupBy") }
            val expected = case.array("expected").map { it as JsonObject }
            val actual = PhonePullRequests.sections(shown, groupBy, now)
            assertEquals(groupBy.wire, expected.map { it.str("key") }, actual.map { it.key })
            assertEquals(groupBy.wire, expected.map { it.str("title") }, actual.map { it.title })
            assertEquals(
                groupBy.wire,
                expected.map { section -> section.array("rows").map { (it as JsonString).value } },
                actual.map { section -> section.rows.map { it.pr.ref.key } },
            )
        }
    }

    @Test
    fun statusCard() {
        fixture.array("statusCard").map { it as JsonObject }.forEach { case ->
            val id = case.str("pr")
            val pr = prs.getValue(id)
            assertLine(id, case.obj("checks"), PhonePullRequests.checksStatus(pr.checks))
            assertLine(id, case.obj("reviews"), PhonePullRequests.reviewsStatus(pr))
            assertLine(id, case.obj("conversations"), PhonePullRequests.conversationsStatus(pr))
            assertLine(id, case.obj("conflicts"), PhonePullRequests.conflictsStatus(pr))
            assertEquals(id, case.str("diffStat"), PhonePullRequests.diffStatLabel(pr))
            assertEquals(id, case.str("age"), PhonePullRequests.ageLabel(pr.updatedAt, now))
        }
    }

    @Test
    fun checks() {
        val case = fixture.obj("checks")
        val input = case.array("input").map { PullRequestDecoders.check(it as JsonObject) }
        assertEquals(
            case.array("ordered").map { (it as JsonString).value },
            PhonePullRequests.orderedChecks(input).map { it.id },
        )
        val trailing = case.obj("trailing")
        input.forEach { check ->
            assertEquals(check.id, trailing.str(check.id), PhonePullRequests.checkTrailing(check))
        }
        assertEquals(case.str("morePassed"), PhonePullRequests.moreChecksLabel(listOf(input[0], input[3])))
        assertEquals(case.str("moreMixed"), PhonePullRequests.moreChecksLabel(input))
        assertEquals("", PhonePullRequests.moreChecksLabel(emptyList()))
    }

    @Test
    fun durationsAndAges() {
        fixture.array("durations").map { (it as JsonArray).values }.forEach { (ms, label) ->
            assertEquals((label as JsonString).value, PhonePullRequests.checkDuration((ms as JsonNumber).source.toLong()))
        }
        fixture.array("ages").map { (it as JsonArray).values }.forEach { (ago, label) ->
            assertEquals(
                (label as JsonString).value,
                PhonePullRequests.ageLabel(now - (ago as JsonNumber).source.toLong(), now),
            )
        }
    }

    @Test
    fun workOnPr() {
        fixture.array("workOnPr").map { it as JsonObject }.forEach { case ->
            val id = case.str("pr")
            val pr = prs.getValue(id)
            val actual = PhonePullRequests.workOnPrCheckout(pr)
            when (val expected = case.values.getValue("checkout")) {
                JsonNull -> assertNull(id, actual)
                is JsonObject -> {
                    val fetch = expected.obj("fetch")
                    val repo = fetch.obj("repo")
                    assertEquals(id, expected.str("name"), actual?.name)
                    assertEquals(id, fetch.str("ref"), actual?.fetch?.ref)
                    assertNull(id, actual?.fetch?.remote)
                    assertEquals(id, repo.str("host"), actual?.fetch?.repo?.host)
                    assertEquals(id, repo.str("owner"), actual?.fetch?.repo?.owner)
                    assertEquals(id, repo.str("name"), actual?.fetch?.repo?.name)
                }
                else -> error("bad workOnPr case $id")
            }
            assertEquals(id, case.str("command"), PhonePullRequests.prCheckoutCommand(pr))
        }
    }

    @Test
    fun hostErrors() {
        fixture.array("hostErrors").map { it as JsonObject }.forEach { case ->
            val id = case.str("id")
            val sources = case.array("sources").map { PullRequestDecoders.source(it as JsonObject) }
            val expected = case.array("expected").map { it as JsonObject }
            val actual = PhonePullRequests.hostErrors(sources)
            assertEquals(id, expected.map { Triple(it.str("host"), it.str("title"), it.str("message")) }, actual.map { Triple(it.host, it.title, it.message) })
        }
    }

    @Test
    fun pillTurns() {
        fixture.array("pillTurns").map { it as JsonObject }.forEach { case ->
            val pill = case.obj("pill")
            val actual = PhonePullRequests.reviewPillTurn(
                case.str("text"),
                PhoneReviewPill(pill.str("label"), pill.str("content")),
                case.str("pillId"),
            )
            val expected = case.obj("expected")
            assertEquals(expected.str("displayBody"), actual.displayBody)
            assertEquals(expected.str("providerText"), actual.providerText)
            val meta = expected.obj("pillsMeta").values.mapValues { (_, value) ->
                val entry = value as JsonObject
                assertEquals("review", entry.str("kind"))
                entry.str("label")
            }
            assertEquals(meta, actual.pillsMeta)
        }
    }

    @Test
    fun subtitles() {
        fixture.array("subtitles").map { it as JsonArray }.forEach { case ->
            val (listed, failed, read, expected) = case.values
            assertEquals(
                (expected as JsonString).value,
                PhonePullRequests.subtitle(
                    (listed as JsonNumber).source.toInt(),
                    (failed as JsonArray).values.map { (it as JsonString).value },
                    (read as JsonArray).values.map { (it as JsonString).value },
                ),
            )
        }
    }

    /** The TS suite's own pill cases (not in the fixture), mirrored so the label and instructions stay equal. */
    @Test
    fun workOnPrPillMatchesTheTypeScriptCases() {
        val checks = fixture.obj("checks").array("input").map { PullRequestDecoders.check(it as JsonObject) }
        val detail = PrDetail(prs.getValue("failed"), "", checks)
        val worktree = PhonePullRequests.workOnPrPill(detail, WorkOnPrPlace.Worktree)
        assertEquals("2 failed checks · #1482 · unit (macos-14), e2e / reviews", worktree.label)
        assertTrue(worktree.content.contains("worktree on the pull request"))
        assertTrue(!worktree.content.contains("gh pr checkout"))
        assertTrue(PhonePullRequests.workOnPrPill(detail, WorkOnPrPlace.Checkout).content.contains("run `gh pr checkout 1482`"))
        val attached = PhonePullRequests.workOnPrPill(detail, WorkOnPrPlace.Attached)
        assertTrue(attached.content.startsWith("Review context from GitHub geoiq/switchboard #1482: Retry uploads"))
        assertTrue(attached.content.endsWith("[2] Failed check: e2e / reviews"))
        assertNull(PhonePullRequests.failedChecksPill(PrDetail(prs.getValue("ready"), "", listOf(checks[0]))))
        assertEquals(
            "Reviews, comments and merges post as you on Bitbucket, so they stay on the desktop app.",
            PhonePullRequests.mergeOnDesktopNote("bitbucket"),
        )
        assertEquals(
            "Merges, closes, reviewers and re-runs stay on the desktop app. " +
                "Replies, comments and reviews from this phone post as you on GitHub.",
            PhonePullRequests.mergeOnDesktopNote("github", canWrite = true),
        )
    }

    @Test
    fun filtersRoundTripThroughStorage() {
        val filters = PhonePrFilters(
            show = PhonePrShow.Mine,
            groupBy = PhonePrGroupBy.Repository,
            checks = PhonePrChecks.Failing,
            excludedRepos = listOf("github:geoiq/gone"),
            showDrafts = false,
            showHidden = true,
        )
        assertEquals(filters, PhonePullRequests.decodeFilters(PhonePullRequests.encodeFilters(filters)))
        assertEquals(PhonePullRequests.DEFAULT_FILTERS, PhonePullRequests.decodeFilters("not json"))
        assertEquals(PhonePullRequests.DEFAULT_FILTERS, PhonePullRequests.decodeFilters(null))
    }

    private fun assertLine(id: String, expected: JsonObject, actual: PhonePrStatusLine) {
        assertEquals(id, expected.str("text"), actual.text)
        assertEquals(id, expected.str("tone"), actual.tone.wire)
    }

    private fun decodeFilters(raw: JsonObject) = PhonePrFilters(
        show = PhonePrShow.entries.single { it.wire == raw.str("show") },
        groupBy = PhonePrGroupBy.entries.single { it.wire == raw.str("groupBy") },
        checks = PhonePrChecks.entries.single { it.wire == raw.str("checks") },
        excludedRepos = raw.array("excludedRepos").map { (it as JsonString).value },
        showDrafts = (raw.values.getValue("showDrafts") as JsonBoolean).value,
        showHidden = (raw.values.getValue("showHidden") as JsonBoolean).value,
    )

    private fun JsonObject.str(key: String) = (values.getValue(key) as JsonString).value
    private fun JsonObject.obj(key: String) = values.getValue(key) as JsonObject
    private fun JsonObject.array(key: String): List<JsonValue> = (values.getValue(key) as JsonArray).values

    private fun loadFixture() = JsonCodec.parse(
        String(
            Files.readAllBytes(
                generateSequence(Path.of("").toAbsolutePath()) { it.parent }
                    .map { it.resolve("tests/fixtures/phone-pr-cases.json") }
                    .firstOrNull(Files::exists)
                    ?: error("Missing tests/fixtures/phone-pr-cases.json"),
            ),
            Charsets.UTF_8,
        ),
    )
}
