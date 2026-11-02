package app.switchboard.mobile.domain.remote

import app.switchboard.mobile.domain.thread.PrLink
import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue
import java.util.Calendar
import java.util.GregorianCalendar
import java.util.Locale
import java.util.TimeZone

/**
 * Snooze's rules, ported from src/shared/chat-snooze.ts and
 * src/shared/chat-snooze-pr.ts: take a chat out of Recents until a time or a
 * PR event, then bring it back with a Woke mark. Every time is local wall time
 * in [zone]; the phone turns a preset into an epoch when the sheet opens.
 * Both run tests/fixtures/chat-snooze-cases.json.
 */
object ChatSnooze {
    const val CAPABILITY = "chat_snooze_v1"

    /** `app:get-snooze-presets` and `app:snooze-presets-changed`: the machine's own presets. */
    const val PRESETS_CAPABILITY = "chat_snooze_presets_v1"

    /** A chat's snooze fields; absent from an older backend. `snoozedAt` is the only test of "is snoozed". */
    data class State(
        val snoozedUntil: Long? = null,
        val snoozedAt: Long? = null,
        val snoozePr: String? = null,
        val snoozeRev: Long = 0,
        val wokeAt: Long? = null,
        val wokeReason: String? = null,
        /** The PR event that woke it, as a status line. */
        val wokePrSummary: String? = null,
        /** Snoozed since the project list was read: a snooze clears the settled mark, so the list's `settledAt` is stale. */
        val unsettled: Boolean = false,
    ) {
        val snoozed: Boolean get() = isSnoozed(snoozedAt)
        val woke: Boolean get() = isWoke(snoozedAt, wokeAt)

        companion object {
            val None = State()
        }
    }

    /** One `app:conversation-snoozed` broadcast. */
    data class Event(val conversationId: String, val state: State)

    fun isSnoozed(snoozedAt: Long?): Boolean = snoozedAt != null

    /** The Woke mark shows. Never on a snoozed chat. */
    fun isWoke(snoozedAt: Long?, wokeAt: Long?): Boolean = snoozedAt == null && wokeAt != null

    /**
     * A sheet item. A duration counts from the tap; the other two are a clock
     * time, frozen at the instant the sheet showed. `weekday` is 0 for Sunday.
     */
    sealed interface PresetSpec {
        val label: String

        data class Duration(override val label: String, val minutes: Int) : PresetSpec

        data class Time(override val label: String, val dayOffset: Int, val hour: Int, val minute: Int) : PresetSpec

        data class Weekday(override val label: String, val weekday: Int, val hour: Int, val minute: Int) : PresetSpec
    }

    val DEFAULT_PRESETS: List<PresetSpec> = listOf(
        PresetSpec.Duration("Later today", 180),
        PresetSpec.Time("Tonight", dayOffset = 0, hour = 20, minute = 0),
        PresetSpec.Time("Tomorrow morning", dayOffset = 1, hour = 9, minute = 0),
        PresetSpec.Weekday("Next week", weekday = 1, hour = 9, minute = 0),
    )

    private val DEFAULT_PRESET_KINDS = listOf("later_today", "tonight", "tomorrow_morning", "next_week")

    const val MAX_PRESETS = 8
    private const val MAX_LABEL = 40

    /** A preset as stored (`chats.snoozePresets`), or null when it is not one. */
    fun parsePresetSpec(raw: JsonValue?): PresetSpec? {
        val o = raw as? JsonObject ?: return null
        val label = (o.values["label"] as? JsonString)?.value?.trim().orEmpty()
        if (label.isEmpty() || label.length > MAX_LABEL) return null
        fun int(key: String, min: Int, max: Int): Int? {
            val n = (o.values[key] as? JsonNumber)?.source?.toDoubleOrNull() ?: return null
            return if (n % 1.0 == 0.0 && n >= min && n <= max) n.toInt() else null
        }
        val kind = (o.values["kind"] as? JsonString)?.value
        if (kind == "duration") return int("minutes", 5, 365 * 24 * 60)?.let { PresetSpec.Duration(label, it) }
        val hour = int("hour", 0, 23) ?: return null
        val minute = int("minute", 0, 59) ?: return null
        return when (kind) {
            "time" -> int("dayOffset", 0, 1)?.let { PresetSpec.Time(label, it, hour, minute) }
            "weekday" -> int("weekday", 0, 6)?.let { PresetSpec.Weekday(label, it, hour, minute) }
            else -> null
        }
    }

    /** The stored list, or the defaults when it is missing or holds nothing usable. */
    fun parsePresetList(raw: JsonValue?): List<PresetSpec> {
        val specs = (raw as? JsonArray)?.values?.mapNotNull(::parsePresetSpec).orEmpty()
        return if (specs.isEmpty()) DEFAULT_PRESETS else specs.take(MAX_PRESETS)
    }

    /** An `app:snooze-presets-changed` broadcast's list. */
    fun presetsEventOf(args: JsonArray): List<PresetSpec>? =
        (args.values.firstOrNull() as? JsonObject)?.let { parsePresetList(it.values["presets"]) }

    /** The analytics kind of a preset: a default one by name, any other `preset`. */
    fun presetKindOf(spec: PresetSpec): String =
        DEFAULT_PRESETS.indexOf(spec).let { if (it >= 0) DEFAULT_PRESET_KINDS[it] else "preset" }

    /** `at` is the epoch shown in the sheet; a duration's is recomputed on the tap ([pickPreset]). */
    data class PresetOption(val label: String, val at: Long, val spec: PresetSpec)

    sealed interface Pick {
        data class At(val at: Long) : Pick

        data object Past : Pick
    }

    /** A linked open PR a snooze can wait on. */
    data class PrChoice(val key: String, val number: Long)

    private const val MINUTE_MS = 60_000L
    private const val DAY_MS = 24 * 60 * MINUTE_MS
    private const val MAX_SNOOZE_MS = 365 * DAY_MS
    private const val DURATION_LAST_HOUR = 21
    private val WEEKDAYS = listOf("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")
    private val MONTHS = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

    /** The sheet: soonest first, one item per minute (the first spec wins a tie). */
    fun resolvePresets(
        now: Long,
        specs: List<PresetSpec> = DEFAULT_PRESETS,
        zone: TimeZone = TimeZone.getDefault(),
    ): List<PresetOption> {
        val seen = mutableSetOf<Long>()
        val out = mutableListOf<PresetOption>()
        for (spec in specs) {
            val at = presetTime(spec, now, zone) ?: continue
            if (!seen.add(Math.floorDiv(at, MINUTE_MS))) continue
            out += PresetOption(spec.label, at, spec)
        }
        return out.sortedBy(PresetOption::at)
    }

    /** What a tap sends: a duration counts from the tap, a clock time keeps the instant the sheet showed. */
    fun pickPreset(option: PresetOption, now: Long, zone: TimeZone = TimeZone.getDefault()): Pick {
        val spec = option.spec
        if (spec is PresetSpec.Duration) return Pick.At(durationEnd(now, spec.minutes, zone))
        return if (option.at > now) Pick.At(option.at) else Pick.Past
    }

    /** `512` from `github:owner/repo#512`. */
    fun prNumberOf(pr: String): String {
        val i = pr.lastIndexOf('#')
        return if (i >= 0) pr.substring(i + 1) else pr
    }

    /** The time cell of a snoozed row: `20:00` today, `Tue 09:00` within a week, `12 Nov` after, `PR #512` for a PR wake. */
    fun wakeLabel(until: Long?, pr: String?, now: Long, zone: TimeZone = TimeZone.getDefault()): String {
        if (until == null) return if (pr != null) "PR #${prNumberOf(pr)}" else ""
        val at = local(until, zone)
        val days = Math.round((localDay(until, 0, 0, 0, zone) - localDay(now, 0, 0, 0, zone)).toDouble() / DAY_MS)
        if (days <= 0) return hhmm(at)
        if (days < 7) return "${WEEKDAYS[jsDay(at)]} ${hhmm(at)}"
        return "${at.get(Calendar.DAY_OF_MONTH)} ${MONTHS[at.get(Calendar.MONTH)]}"
    }

    /** Snoozed rows: the soonest wake first, PR-only snoozes (no time) last. */
    fun compareSnoozeWake(a: Long?, b: Long?): Int {
        if (a == null || b == null) return (if (a == null) 1 else 0) - (if (b == null) 1 else 0)
        return a.compareTo(b)
    }

    /** The line of an open snoozed chat. */
    fun snoozeLineText(until: Long?, pr: String?, now: Long, zone: TimeZone = TimeZone.getDefault()): String {
        if (until != null) return "Snoozed until ${wakeLabel(until, null, now, zone)}"
        return if (pr != null) "Snoozed until PR #${prNumberOf(pr)} changes" else "Snoozed"
    }

    /** What every client says when the backend refuses a snooze. */
    fun snoozeRefusalText(reason: String): String = when (reason) {
        "needs_you" -> "A chat that needs you cannot be snoozed"
        "past" -> "That time has passed. Pick another"
        "too_far" -> "Pick a time within a year"
        "pr_closed" -> "That pull request is closed"
        "pr_unlinked" -> "That pull request is not linked to this chat"
        "pr_unreadable" -> "The pull request could not be read"
        "stale" -> "The chat changed since. Nothing to undo"
        "empty" -> "Pick a time"
        else -> "This chat cannot be snoozed"
    }

    /** The newest link not known to be merged or closed, keyed as `prKey`. */
    fun snoozePrOf(links: List<PrLink>): PrChoice? {
        val open = links
            .filter { it.state != "merged" && it.state != "closed" }
            .maxByOrNull(PrLink::linkedAt)
            ?: return null
        val ref = open.ref
        return PrChoice("${ref.host}:${ref.owner}/${ref.name}".lowercase() + "#${ref.number}", ref.number)
    }

    /** The `app:snooze-conversation` request: `{ until, pr?, preset, surface: 'phone' }`. */
    fun request(until: Long?, pr: String?, preset: String): JsonObject = JsonObject(
        linkedMapOf<String, JsonValue>(
            "until" to (until?.let { JsonNumber(it.toString()) } ?: JsonNull),
        ).apply {
            if (pr != null) put("pr", JsonString(pr))
            put("preset", JsonString(preset))
            put("surface", JsonString("phone"))
        },
    )

    /** `app:snooze-conversation` answer. */
    sealed interface SnoozeAnswer {
        data class Snoozed(val until: Long?, val pr: String?, val rev: Long) : SnoozeAnswer

        data class Refused(val reason: String) : SnoozeAnswer
    }

    /** `app:unsnooze-conversation` answer; `rev` is the revision after the wake. */
    data class WakeAnswer(val ok: Boolean, val rev: Long?)

    fun snoozeAnswer(value: JsonValue?): SnoozeAnswer {
        val raw = value as? JsonObject ?: error("Expected snooze response object")
        return if ((raw.values["ok"] as? JsonBoolean)?.value == true) {
            SnoozeAnswer.Snoozed(raw.long("until"), raw.string("pr"), raw.long("rev") ?: 0)
        } else {
            SnoozeAnswer.Refused(raw.string("reason") ?: "no_row")
        }
    }

    fun wakeAnswer(value: JsonValue?): WakeAnswer {
        val raw = value as? JsonObject ?: error("Expected wake response object")
        return WakeAnswer((raw.values["ok"] as? JsonBoolean)?.value == true, raw.long("rev"))
    }

    /** The state the backend will broadcast after a snooze, applied at once from its answer. */
    fun snoozed(answer: SnoozeAnswer.Snoozed, now: Long): State =
        State(snoozedUntil = answer.until, snoozedAt = now, snoozePr = answer.pr, snoozeRev = answer.rev)

    /** The state after Wake now: not snoozed, no Woke mark. */
    fun woken(answer: WakeAnswer, prior: State): State = State(snoozeRev = answer.rev ?: (prior.snoozeRev + 1))

    /** A broadcast's arguments: the event object first. */
    fun eventOf(args: JsonArray): Event? = (args.values.firstOrNull() as? JsonObject)?.let(::event)

    fun event(raw: JsonObject): Event? {
        val id = (raw.values["conversationId"] as? JsonString)?.value ?: return null
        return Event(id, stateOf(raw).copy(wokePrSummary = raw.string("prSummary")))
    }

    /** The snooze fields of a `SessionSummary` or a broadcast. */
    fun stateOf(raw: JsonObject): State = State(
        snoozedUntil = raw.long("snoozedUntil"),
        snoozedAt = raw.long("snoozedAt"),
        snoozePr = raw.string("snoozePr"),
        snoozeRev = raw.long("snoozeRev") ?: 0,
        wokeAt = raw.long("wokeAt"),
        wokeReason = raw.string("wokeReason"),
        wokePrSummary = raw.string("wokePrSummary"),
    )

    /**
     * Which of two copies of a chat's state to show: the higher revision; on a
     * tie the [local] one, which only ever clears a Woke mark the backend has
     * not yet echoed.
     */
    fun newer(remote: State, local: State?): State =
        if (local != null && local.snoozeRev >= remote.snoozeRev) local else remote

    private fun JsonObject.long(key: String): Long? =
        (values[key] as? JsonNumber)?.source?.let { it.toLongOrNull() ?: it.toDoubleOrNull()?.toLong() }

    private fun JsonObject.string(key: String): String? = (values[key] as? JsonString)?.value

    /** A Gregorian calendar in [zone] at [epochMs], whatever the device locale's calendar system. */
    private fun local(epochMs: Long, zone: TimeZone): Calendar =
        GregorianCalendar(zone, Locale.ROOT).apply { timeInMillis = epochMs }

    /**
     * Local [hour]:[minute] [days] calendar days from [now] (not 24 h steps, so DST days count once).
     * A time in a DST gap moves forward by the gap; a time a fall-back repeats takes the earlier instant.
     */
    private fun localDay(now: Long, days: Long, hour: Int, minute: Int, zone: TimeZone): Long {
        val day = local(now, zone)
        val at = GregorianCalendar(zone, Locale.ROOT).apply {
            clear()
            val date = day.get(Calendar.DAY_OF_MONTH) + days.toInt()
            set(day.get(Calendar.YEAR), day.get(Calendar.MONTH), date, hour, minute, 0)
        }
        val t = at.timeInMillis
        val shift = zone.getOffset(t - 6 * 60 * MINUTE_MS) - zone.getOffset(t)
        if (shift > 0) {
            val earlier = local(t - shift, zone)
            if (earlier.get(Calendar.HOUR_OF_DAY) == hour && earlier.get(Calendar.MINUTE) == minute) {
                return earlier.timeInMillis
            }
        }
        return t
    }

    private fun durationEnd(now: Long, minutes: Int, zone: TimeZone): Long {
        val end = now + minutes * MINUTE_MS
        val unit = if (minutes >= 60) 30 else 1
        val at = local(end, zone)
        val rest = (at.get(Calendar.MINUTE) % unit) * MINUTE_MS +
            at.get(Calendar.SECOND) * 1000L + at.get(Calendar.MILLISECOND)
        val rounded = if (rest == 0L) end else end - rest + unit * MINUTE_MS
        // Rounding up a duration near a year would pass the wake limit the backend checks.
        return minOf(rounded, now + MAX_SNOOZE_MS)
    }

    private fun presetTime(spec: PresetSpec, now: Long, zone: TimeZone): Long? = when (spec) {
        is PresetSpec.Duration -> {
            val end = durationEnd(now, spec.minutes, zone)
            val endAt = local(end, zone)
            val nowAt = local(now, zone)
            val sameDay = endAt.get(Calendar.DAY_OF_MONTH) == nowAt.get(Calendar.DAY_OF_MONTH) &&
                endAt.get(Calendar.MONTH) == nowAt.get(Calendar.MONTH)
            if (spec.minutes < 24 * 60 && (!sameDay || endAt.get(Calendar.HOUR_OF_DAY) >= DURATION_LAST_HOUR)) null else end
        }
        is PresetSpec.Time -> {
            val at = localDay(now, spec.dayOffset.toLong(), spec.hour, spec.minute, zone)
            if (spec.dayOffset == 0 && at - now <= 60 * MINUTE_MS) null else at
        }
        is PresetSpec.Weekday -> {
            val ahead = ((spec.weekday - jsDay(local(now, zone)) + 7) % 7).let { if (it == 0) 7 else it }
            localDay(now, ahead.toLong(), spec.hour, spec.minute, zone)
        }
    }

    /** 0 for Sunday, as the shared rules count weekdays. */
    private fun jsDay(at: Calendar): Int = at.get(Calendar.DAY_OF_WEEK) - Calendar.SUNDAY

    private fun hhmm(at: Calendar): String =
        "${at.get(Calendar.HOUR_OF_DAY).toString().padStart(2, '0')}:${at.get(Calendar.MINUTE).toString().padStart(2, '0')}"
}
