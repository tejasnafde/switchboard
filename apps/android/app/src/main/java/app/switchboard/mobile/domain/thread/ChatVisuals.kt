package app.switchboard.mobile.domain.thread

import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonCodec
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue

/**
 * Port of src/shared/chat-visuals.ts: which fenced blocks of a message are
 * drawn (```mermaid, ```chart) and the chart spec validator. Both suites run
 * tests/fixtures/chart-spec-cases.json and tests/fixtures/visual-fence-cases.json,
 * so the error messages and the split are the same text on every client.
 */
enum class VisualKind(val wire: String) { MERMAID("mermaid"), CHART("chart") }

sealed interface MessageSegment {
    data class Markdown(val text: String) : MessageSegment
    data class Visual(val kind: VisualKind, val source: String) : MessageSegment
}

data class ChartSeries(val name: String, val values: List<Double>)

data class ChartSpec(
    val type: String,
    val labels: List<String>,
    val series: List<ChartSeries>,
    val title: String? = null,
    val xTitle: String? = null,
    val yTitle: String? = null,
)

sealed interface ChartParse {
    data class Ok(val spec: ChartSpec) : ChartParse
    data class Invalid(val error: String) : ChartParse
}

object ChatVisuals {
    const val MAX_VISUAL_SOURCE_CHARS = 20_000
    const val MAX_VISUALS_PER_MESSAGE = 12
    private const val MAX_LABELS = 50
    private const val MAX_SERIES = 8
    private const val MAX_LABEL_CHARS = 60
    private const val MAX_TITLE_CHARS = 120
    private val specKeys = setOf("version", "type", "title", "labels", "series", "xTitle", "yTitle")
    private val seriesKeys = setOf("name", "values")
    private val fenceOpen = Regex("^ {0,3}(`{3,}|~{3,})(.*)$")
    private val fenceClose = Regex("^ {0,3}([`~]+)[ \\t]*$")

    fun visualKindOfInfo(info: String): VisualKind? =
        when (info.trim().split(Regex("\\s+")).firstOrNull()?.lowercase()) {
            "mermaid" -> VisualKind.MERMAID
            "chart" -> VisualKind.CHART
            else -> null
        }

    /** Only a closed top-level fence becomes a visual; see the TypeScript original. */
    fun splitVisualBlocks(markdown: String): List<MessageSegment> {
        val lines = markdown.replace("\r\n", "\n").replace('\r', '\n').split('\n')
        val segments = mutableListOf<MessageSegment>()
        var textStart = 0
        var visuals = 0
        var i = 0
        while (i < lines.size) {
            val open = fenceOpen.matchEntire(lines[i])
            val fence = open?.groupValues?.get(1)
            if (open == null || fence == null || (fence[0] == '`' && open.groupValues[2].contains('`'))) {
                i++
                continue
            }
            var close = i + 1
            while (close < lines.size && !closesFence(lines[close], fence)) close++
            if (close >= lines.size) break
            val kind = visualKindOfInfo(open.groupValues[2])
            val source = lines.subList(i + 1, close).joinToString("\n")
            if (kind != null && visuals < MAX_VISUALS_PER_MESSAGE && source.isNotBlank() &&
                source.length <= MAX_VISUAL_SOURCE_CHARS
            ) {
                pushMarkdown(segments, lines.subList(textStart, i).joinToString("\n"))
                segments += MessageSegment.Visual(kind, source)
                visuals++
                textStart = close + 1
            }
            i = close + 1
        }
        if (segments.isEmpty()) return listOf(MessageSegment.Markdown(markdown))
        pushMarkdown(segments, lines.subList(textStart, lines.size).joinToString("\n"))
        return segments
    }

    private fun closesFence(line: String, fence: String): Boolean {
        val marker = fenceClose.matchEntire(line)?.groupValues?.get(1) ?: return false
        return marker.length >= fence.length && marker.all { it == fence[0] }
    }

    private fun pushMarkdown(segments: MutableList<MessageSegment>, text: String) {
        if (text.isNotBlank()) segments += MessageSegment.Markdown(text)
    }

    fun parseChartSpec(source: String): ChartParse {
        if (source.length > MAX_VISUAL_SOURCE_CHARS) {
            return ChartParse.Invalid("The chart is longer than $MAX_VISUAL_SOURCE_CHARS characters.")
        }
        val raw = runCatching { JsonCodec.parse(source) }.getOrNull()
            ?: return ChartParse.Invalid("The chart is not valid JSON.")
        return try {
            ChartParse.Ok(validate(raw))
        } catch (error: InvalidChart) {
            ChartParse.Invalid("${error.message}.")
        }
    }

    /** Tab-separated rows for Copy, matching chartDataText. */
    fun chartDataText(spec: ChartSpec): String {
        fun cell(value: String) = value.replace(Regex("[\\t\\r\\n]+"), " ")
        val header = (listOf(cell(spec.xTitle ?: "")) + spec.series.map { cell(it.name) }).joinToString("\t")
        val rows = spec.labels.mapIndexed { i, label ->
            (listOf(cell(label)) + spec.series.map { formatNumber(it.values[i]) }).joinToString("\t")
        }
        return (listOf(header) + rows).joinToString("\n")
    }

    /** JavaScript's String(number): plain digits in [1e-6, 1e21), else "1.5e+21" / "1e-7". */
    fun formatNumber(value: Double): String {
        if (value == 0.0) return "0"
        // Double.toString is the shortest round-trip digits, as JavaScript uses.
        val shortest = java.math.BigDecimal(value.toString())
        val abs = Math.abs(value)
        if (abs >= 1e-6 && abs < 1e21) return shortest.stripTrailingZeros().toPlainString()
        val (mantissa, exponent) = value.toString().split('E')
        val digits = mantissa.removeSuffix(".0")
        val exp = exponent.toInt()
        return "${digits}e${if (exp > 0) "+" else ""}$exp"
    }

    private class InvalidChart(message: String) : Exception(message)

    private fun fail(message: String): Nothing = throw InvalidChart(message)

    private fun JsonValue?.number(): Double? = (this as? JsonNumber)?.source?.toDoubleOrNull()

    private fun text(value: JsonValue?, path: String, max: Int): String {
        val string = (value as? JsonString)?.value ?: fail("$path must be a string")
        if (string.length > max) fail("$path is longer than $max characters")
        return string
    }

    private fun optionalText(obj: JsonObject, key: String, max: Int): String? {
        if (!obj.values.containsKey(key)) return null
        return text(obj.values[key], "\"$key\"", max)
    }

    private fun validate(raw: JsonValue): ChartSpec {
        val obj = raw as? JsonObject ?: fail("The chart must be a JSON object")
        obj.values.keys.firstOrNull { it !in specKeys }?.let { fail("Unknown key \"$it\"") }
        if (obj.values.containsKey("version") && obj.values["version"].number() != 1.0) {
            fail("Unsupported version; use 1")
        }
        val type = (obj.values["type"] as? JsonString)?.value
        if (type != "bar" && type != "line" && type != "table") fail("\"type\" must be \"bar\", \"line\" or \"table\"")
        val rawLabels = (obj.values["labels"] as? JsonArray)?.values
        if (rawLabels == null || rawLabels.isEmpty() || rawLabels.size > MAX_LABELS) {
            fail("\"labels\" must be a list of 1 to $MAX_LABELS strings")
        }
        val labels = rawLabels.mapIndexed { i, label -> text(label, "labels[$i]", MAX_LABEL_CHARS) }
        val rawSeries = (obj.values["series"] as? JsonArray)?.values
        if (rawSeries == null || rawSeries.isEmpty() || rawSeries.size > MAX_SERIES) {
            fail("\"series\" must be a list of 1 to $MAX_SERIES series")
        }
        val series = rawSeries.mapIndexed { s, entry ->
            val item = entry as? JsonObject ?: fail("series[$s] must be an object")
            item.values.keys.firstOrNull { it !in seriesKeys }?.let { fail("Unknown key \"$it\" in series[$s]") }
            val name = text(item.values["name"], "series[$s].name", MAX_LABEL_CHARS)
            val values = (item.values["values"] as? JsonArray)?.values
            if (values == null || values.size != labels.size) {
                fail("series[$s].values must have one number per label (${labels.size})")
            }
            ChartSeries(
                name,
                values.mapIndexed { v, value ->
                    value.number()?.takeIf { it.isFinite() } ?: fail("series[$s].values[$v] must be a finite number")
                },
            )
        }
        return ChartSpec(
            type = type,
            labels = labels,
            series = series,
            title = optionalText(obj, "title", MAX_TITLE_CHARS),
            xTitle = optionalText(obj, "xTitle", MAX_LABEL_CHARS),
            yTitle = optionalText(obj, "yTitle", MAX_LABEL_CHARS),
        )
    }
}
