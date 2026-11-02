package app.switchboard.mobile.domain.remote

import app.switchboard.mobile.domain.thread.PrLink
import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime

/**
 * Snooze's rules, ported from src/shared/chat-snooze.ts and
 * src/shared/chat-snooze-pr.ts: take a chat out of Recents until a time or a
 * PR event, then bring it back with a Woke mark. Every time is local wall time
 * in [zone]; the phone turns a preset into an epoch when the sheet opens.
 * Both run tests/fixtures/chat-snooze-cases.json.
 */
object ChatSnooze {
    const val CAPABILITY = "chat_snooze_v1"

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
    private const val DURATION_LAST_HOUR = 21
    private val WEEKDAYS = listOf("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")
    private val MONTHS = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

    /** The sheet: soonest first, one item per minute (the first spec wins a tie). */
    fun resolvePresets(
        now: Long,
        specs: List<PresetSpec> = DEFAULT_PRESETS,
        zone: ZoneId = ZoneId.systemDefault(),
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
    fun pickPreset(option: PresetOption, now: Long, zone: ZoneId = ZoneId.systemDefault()): Pick {
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
    fun wakeLabel(until: Long?, pr: String?, now: Long, zone: ZoneId = ZoneId.systemDefault()): String {
        if (until == null) return if (pr != null) "PR #${prNumberOf(pr)}" else ""
        val at = local(until, zone)
        val days = Math.round((localDay(until, 0, 0, 0, zone) - localDay(now, 0, 0, 0, zone)).toDouble() / DAY_MS)
        if (days <= 0) return hhmm(at)
        if (days < 7) return "${WEEKDAYS[jsDay(at)]} ${hhmm(at)}"
        return "${at.dayOfMonth} ${MONTHS[at.monthValue - 1]}"
    }

    /** Snoozed rows: the soonest wake first, PR-only snoozes (no time) last. */
    fun compareSnoozeWake(a: Long?, b: Long?): Int {
        if (a == null || b == null) return (if (a == null) 1 else 0) - (if (b == null) 1 else 0)
        return a.compareTo(b)
    }

    /** The line of an open snoozed chat. */
    fun snoozeLineText(until: Long?, pr: String?, now: Long, zone: ZoneId = ZoneId.systemDefault()): String {
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

    private fun local(epochMs: Long, zone: ZoneId): ZonedDateTime = Instant.ofEpochMilli(epochMs).atZone(zone)

    /** Local [hour]:[minute] [days] calendar days from [now] (not 24 h steps, so DST days count once). */
    private fun localDay(now: Long, days: Long, hour: Int, minute: Int, zone: ZoneId): Long =
        local(now, zone).toLocalDate().plusDays(days).atTime(hour, minute).atZone(zone).toInstant().toEpochMilli()

    private fun durationEnd(now: Long, minutes: Int, zone: ZoneId): Long {
        val end = now + minutes * MINUTE_MS
        val unit = if (minutes >= 60) 30 else 1
        val at = local(end, zone)
        val rest = (at.minute % unit) * MINUTE_MS + at.second * 1000L + at.nano / 1_000_000
        return if (rest == 0L) end else end - rest + unit * MINUTE_MS
    }

    private fun presetTime(spec: PresetSpec, now: Long, zone: ZoneId): Long? = when (spec) {
        is PresetSpec.Duration -> {
            val end = durationEnd(now, spec.minutes, zone)
            val endAt = local(end, zone)
            val nowAt = local(now, zone)
            val sameDay = endAt.dayOfMonth == nowAt.dayOfMonth && endAt.monthValue == nowAt.monthValue
            if (spec.minutes < 24 * 60 && (!sameDay || endAt.hour >= DURATION_LAST_HOUR)) null else end
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
    private fun jsDay(at: ZonedDateTime): Int = at.dayOfWeek.value % 7

    private fun hhmm(at: ZonedDateTime): String =
        "${at.hour.toString().padStart(2, '0')}:${at.minute.toString().padStart(2, '0')}"
}
