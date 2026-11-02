package app.switchboard.mobile.domain.remote

import app.switchboard.mobile.domain.thread.PrLink
import app.switchboard.mobile.domain.thread.PrLinkRef
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
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.util.TimeZone
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Runs tests/fixtures/chat-snooze-cases.json, the cases tests/unit/chat-snooze-rules.test.ts checks. */
class ChatSnoozeFixturesTest {
    private val fixture = loadFixture() as JsonObject
    private val zone = ZoneId.systemDefault()

    @Test
    fun presetsResolveSoonestFirstOnePerMinute() {
        val cases = section("presets")
        assertTrue(cases.isNotEmpty())
        cases.forEach { case ->
            val specs = (case.values["specs"] as JsonArray?)?.values?.map { spec(it as JsonObject) }
                ?: ChatSnooze.DEFAULT_PRESETS
            val options = ChatSnooze.resolvePresets(local(case.str("now")), specs)
            val expected = (case.values.getValue("expect") as JsonArray).values.map { pair ->
                (pair as JsonArray).values.map { (it as JsonString).value }
            }
            assertEquals(case.str("name"), expected, options.map { listOf(it.label, wall(it.at)) })
        }
    }

    @Test
    fun customPresetsResolveAcrossADstChangeAndNearMidnight() {
        val zones = section("presetsDst")
        assertTrue(zones.isNotEmpty())
        zones.forEach { group ->
            val zone = TimeZone.getTimeZone(group.str("zone"))
            (group.values.getValue("cases") as JsonArray).values.map { it as JsonObject }.forEach { case ->
                val specs = (case.values.getValue("specs") as JsonArray).values.map { spec(it as JsonObject) }
                val options = ChatSnooze.resolvePresets(case.long("now"), specs, zone)
                val expected = (case.values.getValue("expect") as JsonArray).values.map { pair ->
                    val (label, at) = (pair as JsonArray).values
                    (label as JsonString).value to (at as JsonNumber).source.toLong()
                }
                assertEquals(case.str("name"), expected, options.map { it.label to it.at })
            }
        }
    }

    @Test
    fun theStoredListKeepsItsPresetsAndFallsBackToTheDefaults() {
        val cases = section("presetList")
        assertTrue(cases.isNotEmpty())
        cases.forEach { case ->
            val expected = (case.values.getValue("expect") as JsonArray).values.map { spec(it as JsonObject) }
            assertEquals(case.str("name"), expected, ChatSnooze.parsePresetList(case.values["raw"]))
        }
    }

    @Test
    fun aStoredPresetFollowsTheSharedRules() {
        section("parsePreset").forEach { case ->
            val ok = (case.values.getValue("ok") as JsonBoolean).value
            assertEquals(case.toString(), ok, ChatSnooze.parsePresetSpec(case.values["raw"]) != null)
        }
    }

    @Test
    fun aPresetsBroadcastCarriesTheList() {
        val raw = JsonCodec.parse(
            """[{"presets":[{"label":"Lunch","kind":"time","dayOffset":0,"hour":13,"minute":0}]}]""",
        ) as JsonArray
        assertEquals(
            listOf(ChatSnooze.PresetSpec.Time("Lunch", dayOffset = 0, hour = 13, minute = 0)),
            ChatSnooze.presetsEventOf(raw),
        )
    }

    @Test
    fun aPickCountsADurationFromTheTapAndRefusesAPassedClockTime() {
        section("pick").forEach { case ->
            val option = ChatSnooze.resolvePresets(local(case.str("shownAt"))).single { it.label == case.str("label") }
            val picked = when (val pick = ChatSnooze.pickPreset(option, local(case.str("clickAt")))) {
                is ChatSnooze.Pick.At -> wall(pick.at)
                ChatSnooze.Pick.Past -> "past"
            }
            assertEquals(case.str("name"), case.str("expect"), picked)
        }
    }

    @Test
    fun wakeLabelsMatchTheSharedRule() {
        section("wakeLabel").forEach { case ->
            assertEquals(
                case.toString(),
                case.str("expect"),
                ChatSnooze.wakeLabel(case.localOrNull("until"), case.strOrNull("pr"), local(case.str("now"))),
            )
        }
    }

    @Test
    fun theShelfPutsTheSoonestWakeFirstAndPrOnlyLast() {
        section("shelfOrder").forEach { case ->
            val rows = (case.values.getValue("rows") as JsonArray).values.map { it as JsonObject }
            val sorted = rows.sortedWith { a, b -> ChatSnooze.compareSnoozeWake(a.localOrNull("until"), b.localOrNull("until")) }
            val expected = (case.values.getValue("expect") as JsonArray).values.map { (it as JsonString).value }
            assertEquals(case.str("name"), expected, sorted.map { it.str("id") })
        }
    }

    @Test
    fun theSnoozeLineMatchesTheSharedRule() {
        section("snoozeLine").forEach { case ->
            assertEquals(
                case.str("expect"),
                ChatSnooze.snoozeLineText(case.localOrNull("until"), case.strOrNull("pr"), local(case.str("now"))),
            )
        }
    }

    @Test
    fun theSnoozePrIsTheNewestOpenLink() {
        section("snoozePr").forEach { case ->
            val links = (case.values.getValue("links") as JsonArray).values.map {
                val link = it as JsonObject
                PrLink(
                    ref = PrLinkRef("github", "acme", "app", link.long("number")),
                    source = "manual",
                    linkedAt = link.long("linkedAt"),
                    state = link.strOrNull("state"),
                )
            }
            val choice = ChatSnooze.snoozePrOf(links)
            when (val expect = case.values["expect"]) {
                null, JsonNull -> assertNull(case.str("name"), choice)
                is JsonObject -> assertEquals(
                    case.str("name"),
                    ChatSnooze.PrChoice(expect.str("key"), expect.long("number")),
                    choice,
                )
                else -> error("Unexpected expect: $expect")
            }
        }
    }

    @Test
    fun everyRefusalHasItsLine() {
        val refusals = fixture.values.getValue("refusal") as JsonObject
        assertTrue(refusals.values.isNotEmpty())
        refusals.values.forEach { (reason, text) ->
            assertEquals(reason, (text as JsonString).value, ChatSnooze.snoozeRefusalText(reason))
        }
    }

    @Test
    fun aDefaultPresetNamesItsKind() {
        assertEquals(
            listOf("later_today", "tonight", "tomorrow_morning", "next_week"),
            ChatSnooze.DEFAULT_PRESETS.map(ChatSnooze::presetKindOf),
        )
        assertEquals("preset", ChatSnooze.presetKindOf(ChatSnooze.PresetSpec.Duration("Later today", 60)))
    }

    private fun spec(raw: JsonObject): ChatSnooze.PresetSpec = when (raw.str("kind")) {
        "duration" -> ChatSnooze.PresetSpec.Duration(raw.str("label"), raw.long("minutes").toInt())
        "time" -> ChatSnooze.PresetSpec.Time(
            raw.str("label"),
            raw.long("dayOffset").toInt(),
            raw.long("hour").toInt(),
            raw.long("minute").toInt(),
        )
        "weekday" -> ChatSnooze.PresetSpec.Weekday(
            raw.str("label"),
            raw.long("weekday").toInt(),
            raw.long("hour").toInt(),
            raw.long("minute").toInt(),
        )
        else -> error("Unknown preset kind in fixture")
    }

    /** `YYYY-MM-DDTHH:MM[:SS]` as local wall time. */
    private fun local(text: String): Long = LocalDateTime.parse(text).atZone(zone).toInstant().toEpochMilli()

    private fun wall(epochMs: Long): String {
        val at = Instant.ofEpochMilli(epochMs).atZone(zone)
        return "%04d-%02d-%02dT%02d:%02d".format(at.year, at.monthValue, at.dayOfMonth, at.hour, at.minute)
    }

    private fun section(name: String) = (fixture.values.getValue(name) as JsonArray).values.map { it as JsonObject }

    private fun JsonObject.str(key: String) = (values.getValue(key) as JsonString).value

    private fun JsonObject.strOrNull(key: String) = (values[key] as? JsonString)?.value

    private fun JsonObject.long(key: String) = (values.getValue(key) as JsonNumber).source.toLong()

    private fun JsonObject.localOrNull(key: String): Long? = strOrNull(key)?.let(::local)

    private fun loadFixture(): JsonValue = JsonCodec.parse(
        String(
            Files.readAllBytes(
                generateSequence(Path.of("").toAbsolutePath()) { it.parent }
                    .map { it.resolve("tests/fixtures/chat-snooze-cases.json") }
                    .firstOrNull(Files::exists)
                    ?: error("Missing tests/fixtures/chat-snooze-cases.json"),
            ),
            Charsets.UTF_8,
        ),
    )
}
