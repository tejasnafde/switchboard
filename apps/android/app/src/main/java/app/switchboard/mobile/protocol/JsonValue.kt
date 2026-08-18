package app.switchboard.mobile.protocol

sealed interface JsonValue

data class JsonObject(
    val values: LinkedHashMap<String, JsonValue>,
) : JsonValue

data class JsonArray(
    val values: List<JsonValue>,
) : JsonValue

data class JsonString(
    val value: String,
) : JsonValue

data class JsonNumber(
    val source: String,
) : JsonValue

data class JsonBoolean(
    val value: Boolean,
) : JsonValue

data object JsonNull : JsonValue

fun JsonValue.requireObject(): JsonObject =
    this as? JsonObject ?: error("Expected JSON object")

fun JsonValue.requireArray(): JsonArray =
    this as? JsonArray ?: error("Expected JSON array")

fun JsonObject.requireValue(key: String): JsonValue =
    values[key] ?: error("Missing JSON field: $key")

fun JsonObject.requireString(key: String): String =
    (requireValue(key) as? JsonString)?.value ?: error("Expected string field: $key")

fun JsonObject.requireBoolean(key: String): Boolean =
    (requireValue(key) as? JsonBoolean)?.value ?: error("Expected boolean field: $key")

internal fun JsonObject.stringOrNull(key: String): String? =
    (values[key] as? JsonString)?.value

internal fun JsonObject.longOrNull(key: String): Long? =
    (values[key] as? JsonNumber)?.source?.toLongOrNull()

internal fun JsonObject.booleanOrNull(key: String): Boolean? =
    (values[key] as? JsonBoolean)?.value

object JsonCodec {
    fun parse(source: String): JsonValue = Parser(source).parse()

    fun encode(value: JsonValue): String = buildString {
        appendValue(value)
    }

    private fun StringBuilder.appendValue(value: JsonValue) {
        when (value) {
            is JsonObject -> {
                append('{')
                value.values.entries.forEachIndexed { index, (key, child) ->
                    if (index > 0) append(',')
                    appendQuoted(key)
                    append(':')
                    appendValue(child)
                }
                append('}')
            }

            is JsonArray -> {
                append('[')
                value.values.forEachIndexed { index, child ->
                    if (index > 0) append(',')
                    appendValue(child)
                }
                append(']')
            }

            is JsonString -> appendQuoted(value.value)
            is JsonNumber -> append(value.source)
            is JsonBoolean -> append(if (value.value) "true" else "false")
            JsonNull -> append("null")
        }
    }

    private fun StringBuilder.appendQuoted(value: String) {
        append('"')
        value.forEach { character ->
            when (character) {
                '"' -> append("\\\"")
                '\\' -> append("\\\\")
                '\b' -> append("\\b")
                '\u000C' -> append("\\f")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                else -> {
                    if (character.code < 0x20) {
                        append("\\u")
                        append(character.code.toString(16).padStart(4, '0'))
                    } else {
                        append(character)
                    }
                }
            }
        }
        append('"')
    }

    private class Parser(
        private val source: String,
    ) {
        private var index = 0

        fun parse(): JsonValue {
            skipWhitespace()
            val value = parseValue()
            skipWhitespace()
            require(index == source.length) { "Unexpected trailing JSON content at $index" }
            return value
        }

        private fun parseValue(): JsonValue {
            require(index < source.length) { "Unexpected end of JSON" }
            return when (source[index]) {
                '{' -> parseObject()
                '[' -> parseArray()
                '"' -> JsonString(parseString())
                't' -> parseLiteral("true", JsonBoolean(true))
                'f' -> parseLiteral("false", JsonBoolean(false))
                'n' -> parseLiteral("null", JsonNull)
                '-', in '0'..'9' -> parseNumber()
                else -> error("Unexpected JSON character at $index")
            }
        }

        private fun parseObject(): JsonObject {
            index++
            skipWhitespace()
            val values = linkedMapOf<String, JsonValue>()
            if (consume('}')) return JsonObject(values)
            while (true) {
                require(peek() == '"') { "Expected object key at $index" }
                val key = parseString()
                skipWhitespace()
                require(consume(':')) { "Expected ':' at $index" }
                skipWhitespace()
                values[key] = parseValue()
                skipWhitespace()
                if (consume('}')) return JsonObject(values)
                require(consume(',')) { "Expected ',' at $index" }
                skipWhitespace()
            }
        }

        private fun parseArray(): JsonArray {
            index++
            skipWhitespace()
            val values = mutableListOf<JsonValue>()
            if (consume(']')) return JsonArray(values)
            while (true) {
                values += parseValue()
                skipWhitespace()
                if (consume(']')) return JsonArray(values)
                require(consume(',')) { "Expected ',' at $index" }
                skipWhitespace()
            }
        }

        private fun parseString(): String {
            require(consume('"')) { "Expected string at $index" }
            val result = StringBuilder()
            while (index < source.length) {
                val character = source[index++]
                when (character) {
                    '"' -> return result.toString()
                    '\\' -> {
                        require(index < source.length) { "Incomplete escape at $index" }
                        when (val escaped = source[index++]) {
                            '"', '\\', '/' -> result.append(escaped)
                            'b' -> result.append('\b')
                            'f' -> result.append('\u000C')
                            'n' -> result.append('\n')
                            'r' -> result.append('\r')
                            't' -> result.append('\t')
                            'u' -> {
                                require(index + 4 <= source.length) { "Incomplete unicode escape at $index" }
                                val code = source.substring(index, index + 4).toIntOrNull(16)
                                    ?: error("Invalid unicode escape at $index")
                                result.append(code.toChar())
                                index += 4
                            }
                            else -> error("Invalid JSON escape: $escaped")
                        }
                    }
                    else -> {
                        require(character.code >= 0x20) { "Unescaped control character at $index" }
                        result.append(character)
                    }
                }
            }
            error("Unterminated JSON string")
        }

        private fun parseNumber(): JsonNumber {
            val start = index
            if (peek() == '-') index++
            if (peek() == '0') {
                index++
            } else {
                require(peek() in '1'..'9') { "Invalid number at $index" }
                while (peek() in '0'..'9') index++
            }
            if (peek() == '.') {
                index++
                require(peek() in '0'..'9') { "Invalid fraction at $index" }
                while (peek() in '0'..'9') index++
            }
            if (peek() == 'e' || peek() == 'E') {
                index++
                if (peek() == '+' || peek() == '-') index++
                require(peek() in '0'..'9') { "Invalid exponent at $index" }
                while (peek() in '0'..'9') index++
            }
            return JsonNumber(source.substring(start, index))
        }

        private fun <T : JsonValue> parseLiteral(literal: String, value: T): T {
            require(source.regionMatches(index, literal, 0, literal.length)) {
                "Invalid JSON literal at $index"
            }
            index += literal.length
            return value
        }

        private fun consume(expected: Char): Boolean {
            if (peek() != expected) return false
            index++
            return true
        }

        private fun peek(): Char? = source.getOrNull(index)

        private fun skipWhitespace() {
            while (peek() == ' ' || peek() == '\n' || peek() == '\r' || peek() == '\t') index++
        }
    }
}
