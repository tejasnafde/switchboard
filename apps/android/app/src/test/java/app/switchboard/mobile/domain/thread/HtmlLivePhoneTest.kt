package app.switchboard.mobile.domain.thread

import app.switchboard.mobile.domain.thread.HtmlLivePhone.Candidate
import app.switchboard.mobile.domain.thread.HtmlLivePhone.LiveRequest
import app.switchboard.mobile.domain.thread.HtmlLivePhone.Report
import app.switchboard.mobile.domain.thread.HtmlLivePhone.Verdict
import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import java.nio.file.Files
import java.nio.file.Path
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HtmlLivePhoneTest {
    private val token = "0123456789abcdef0123456789abcdef"
    private val origin = "https://$token.sb-live.invalid"

    private fun decide(url: String, served: Boolean = false) = HtmlLivePhone.liveRequestDecision(url, token, served)

    @Test
    fun theDocumentEqualsTheSharedFixture() {
        val fixture = JsonCodec.parse(
            String(
                Files.readAllBytes(
                    generateSequence(Path.of("").toAbsolutePath()) { it.parent }
                        .map { it.resolve("tests/fixtures/html-live-phone-document.json") }
                        .firstOrNull(Files::exists)
                        ?: error("Missing tests/fixtures/html-live-phone-document.json"),
                ),
                Charsets.UTF_8,
            ),
        ) as JsonObject
        val t = fixture.values.getValue("theme") as JsonObject
        fun str(key: String) = (t.values.getValue(key) as JsonString).value
        val theme = HtmlLiveTheme(
            scheme = str("scheme"), bg = str("bg"), surface = str("surface"), text = str("text"), muted = str("muted"),
            border = str("border"), accent = str("accent"), success = str("success"), warning = str("warning"),
            error = str("error"), font = str("font"), mono = str("mono"), radius = str("radius"),
            chart = (t.values.getValue("chart") as JsonArray).values.map { (it as JsonString).value },
        )
        assertEquals(theme, HtmlLivePhone.THEME)
        // Android loads libraries from its own origin; the inline cases are iOS only.
        val cases = (fixture.values.getValue("cases") as JsonArray).values.map { it as JsonObject }
            .filter { (it.values.getValue("inline") as JsonBoolean).value.not() }
        assertEquals(6, cases.size)
        for (case in cases) {
            val name = (case.values.getValue("name") as JsonString).value
            val source = (case.values.getValue("source") as JsonString).value
            assertEquals(name, (case.values.getValue("document") as JsonString).value, HtmlLivePhone.document(source, theme))
        }
    }

    @Test
    fun theDocumentStartsWithTheCsp() {
        val doc = HtmlLivePhone.document("<script>early()</script><head></head>")
        assertTrue(doc.startsWith("<!doctype html><html data-sb-theme=\"dark\"><head><meta http-equiv=\"Content-Security-Policy\""))
    }

    @Test
    fun servesTheDocumentOnceThenCountsAReload() {
        assertEquals(LiveRequest.Document, decide("$origin/index.html"))
        assertEquals(LiveRequest.Reload, decide("$origin/index.html", served = true))
        assertEquals(LiveRequest.Reload, decide("$origin/index.html?again", served = true))
    }

    @Test
    fun servesEachShippedLibrary() {
        for (path in listOf("chart.js", "d3.js", "three.js", "three/addons/controls/OrbitControls.js")) {
            val decision = decide("$origin/_sb/$path", served = true)
            assertEquals(path, LiveRequest.Library(path), decision)
            assertEquals("text/javascript", (decision as LiveRequest.Library).mime)
        }
    }

    @Test
    fun blocksEverythingElse() {
        for (url in listOf(
            "$origin/_sb/mermaid.js",
            "$origin/_sb/licenses/d3-LICENSE",
            "$origin/_sb/../index.html",
            "$origin/other.html",
            "$origin/",
            "https://example.com/index.html",
            "https://example.com/_sb/chart.js",
            "http://$token.sb-live.invalid/index.html",
            "http://10.0.2.2/",
            "http://127.0.0.1:9/",
            "https://ffffffffffffffffffffffffffffffff.sb-live.invalid/index.html",
            "https://ffffffffffffffffffffffffffffffff.sb-live.invalid/_sb/chart.js",
            "https://sb-live.invalid/index.html",
            "https://$token.sb-live.invalid.example.com/index.html",
            "https://user@$token.sb-live.invalid/index.html",
            "https://$token.sb-live.invalid:8443/index.html",
            "ws://$token.sb-live.invalid/index.html",
            "wss://example.com/socket",
            "ws://10.0.2.2:8080/",
            "file:///proc/self/status",
            "file:///android_asset/chart.js",
            "content://settings/system",
            "intent://x#Intent;scheme=https;end",
            "data:text/html,<p>x</p>",
            "blob:$origin/1234",
            "javascript:alert(1)",
            "https://cdn.example.com/image.png",
            "https://fonts.example.com/font.woff2",
            "https://example.com/style.css",
            "not a url",
            "",
        )) {
            assertEquals(url, LiveRequest.Blocked, decide(url))
        }
        assertEquals(LiveRequest.Blocked, HtmlLivePhone.liveRequestDecision("https://.sb-live.invalid/index.html", "", false))
    }

    @Test
    fun parsesConsoleLines() {
        assertEquals(Report.Height(312.0), HtmlLivePhone.parseConsole("__sb_live_height__:312", false))
        assertNull(HtmlLivePhone.parseConsole("__sb_live_height__:-1", false))
        assertNull(HtmlLivePhone.parseConsole("__sb_live_height__:NaN", false))
        assertEquals(Report.Blocked("https://example.com/x"), HtmlLivePhone.parseConsole("__sb_live_blocked__:https://example.com/x", false))
        assertEquals(Report.Error("boom"), HtmlLivePhone.parseConsole("boom", true))
        assertNull(HtmlLivePhone.parseConsole("hello", false))
        assertEquals(300, (HtmlLivePhone.parseConsole("x".repeat(1000), true) as Report.Error).text.length)
    }

    @Test
    fun readsAtMostOneHundredLinesASecondAndKeepsTwentyReports() {
        val reports = HtmlLivePhone.Reports()
        val read = (1..150).count { reports.console("e$it", isError = true, nowMs = 5_000L + it) != null }
        assertEquals(100, read)
        assertEquals(20, reports.errors.size)
        assertEquals(Report.Height(10.0), reports.console("__sb_live_height__:10", false, 6_000L))
        repeat(30) { reports.console("__sb_live_blocked__:u$it", false, 6_001L) }
        assertEquals(20, reports.blocked.size)
    }

    @Test
    fun verdictRefusesOpenLargeUnknownAndDesktopOnly() {
        assertEquals(Verdict.Open, HtmlLivePhone.verdict("<p>x</p>", closed = false))
        assertEquals(Verdict.Ok(listOf("Chart.js")), HtmlLivePhone.verdict("<script src=\"/_sb/chart.js\"></script>", true))
        assertEquals(Verdict.Ok(listOf("Three.js")), HtmlLivePhone.verdict("import * as T from 'three'", true))
        assertTrue(HtmlLivePhone.verdict("x".repeat(128 * 1024 + 1), true) is Verdict.TooLarge)
        assertEquals(Verdict.UnknownLibrary(listOf("vue.js")), HtmlLivePhone.verdict("/_sb/vue.js", true))
        assertEquals(Verdict.DesktopOnly(listOf("mermaid.js")), HtmlLivePhone.verdict("/_sb/mermaid.js", true))
    }

    @Test
    fun runsOnePage() {
        val a = Candidate("a", "ka", 0.9f, runPressed = false, fullScreen = false)
        val b = Candidate("b", "kb", 0.6f, runPressed = false, fullScreen = false)
        val none = emptyMap<String, Int>()
        assertEquals("a", HtmlLivePhone.running(listOf(a, b), 300, lowRam = false, crashes = none))
        assertNull(HtmlLivePhone.running(listOf(a, b), 299, lowRam = false, crashes = none))
        assertNull(HtmlLivePhone.running(listOf(a.copy(visible = 0.4f)), 1_000, lowRam = false, crashes = none))
        assertNull(HtmlLivePhone.running(listOf(a), 1_000, lowRam = true, crashes = none))
        assertEquals("a", HtmlLivePhone.running(listOf(a.copy(runPressed = true)), 1_000, lowRam = true, crashes = none))
        assertEquals("b", HtmlLivePhone.running(listOf(a, b), 1_000, lowRam = false, crashes = mapOf("ka" to 1)))
        assertNull(HtmlLivePhone.running(listOf(a.copy(runPressed = true)), 1_000, lowRam = false, crashes = mapOf("ka" to 2)))
        val full = Candidate("f", "kb", 1f, runPressed = true, fullScreen = true)
        assertEquals("f", HtmlLivePhone.running(listOf(a, full), 0, lowRam = true, crashes = none))
        assertTrue(HtmlLivePhone.lowRam(2L * 1024 * 1024 * 1024, false))
        assertTrue(HtmlLivePhone.lowRam(8L * 1024 * 1024 * 1024, true))
        assertEquals(false, HtmlLivePhone.lowRam(3L * 1024 * 1024 * 1024, false))
        assertEquals(120, HtmlLivePhone.frameHeight(10.0))
        assertEquals(480, HtmlLivePhone.frameHeight(4_000.0))
    }
}
