package app.switchboard.mobile.compat

internal sealed interface LegacyJson {
    data class Object(val values: LinkedHashMap<String, LegacyJson>) : LegacyJson
    data class Array(val values: List<LegacyJson>) : LegacyJson
    data class StringValue(val value: String) : LegacyJson
    data class NumberValue(val source: String) : LegacyJson
    data class BooleanValue(val value: Boolean) : LegacyJson
    data object NullValue : LegacyJson
}

internal class LegacyJsonException(message: String) : IllegalArgumentException(message)

internal object LegacyJsonParser {
    fun parse(source: String): LegacyJson = Parser(source).parse()

    private class Parser(private val source: String) {
        private var offset = 0

        fun parse(): LegacyJson {
            skipWhitespace()
            val value = readValue()
            skipWhitespace()
            if (offset != source.length) fail("unexpected trailing content")
            return value
        }

        private fun readValue(): LegacyJson {
            if (offset >= source.length) fail("unexpected end of input")
            return when (source[offset]) {
                '{' -> readObject()
                '[' -> readArray()
                '"' -> LegacyJson.StringValue(readString())
                't' -> readLiteral("true", LegacyJson.BooleanValue(true))
                'f' -> readLiteral("false", LegacyJson.BooleanValue(false))
                'n' -> readLiteral("null", LegacyJson.NullValue)
                '-', in '0'..'9' -> readNumber()
                else -> fail("unexpected character '${source[offset]}'")
            }
        }

        private fun readObject(): LegacyJson.Object {
            offset += 1
            skipWhitespace()
            val values = linkedMapOf<String, LegacyJson>()
            if (consume('}')) return LegacyJson.Object(values)
            while (true) {
                if (offset >= source.length || source[offset] != '"') fail("object key must be a string")
                val key = readString()
                skipWhitespace()
                expect(':')
                skipWhitespace()
                if (values.put(key, readValue()) != null) fail("duplicate object key '$key'")
                skipWhitespace()
                if (consume('}')) return LegacyJson.Object(values)
                expect(',')
                skipWhitespace()
            }
        }

        private fun readArray(): LegacyJson.Array {
            offset += 1
            skipWhitespace()
            val values = mutableListOf<LegacyJson>()
            if (consume(']')) return LegacyJson.Array(values)
            while (true) {
                values += readValue()
                skipWhitespace()
                if (consume(']')) return LegacyJson.Array(values)
                expect(',')
                skipWhitespace()
            }
        }

        private fun readString(): String {
            expect('"')
            val result = StringBuilder()
            while (offset < source.length) {
                val char = source[offset++]
                when {
                    char == '"' -> return result.toString()
                    char == '\\' -> result.append(readEscape())
                    char.code < 0x20 -> fail("unescaped control character in string")
                    else -> result.append(char)
                }
            }
            fail("unterminated string")
        }

        private fun readEscape(): Char {
            if (offset >= source.length) fail("unterminated escape")
            return when (val escaped = source[offset++]) {
                '"', '\\', '/' -> escaped
                'b' -> '\b'
                'f' -> '\u000c'
                'n' -> '\n'
                'r' -> '\r'
                't' -> '\t'
                'u' -> {
                    if (offset + 4 > source.length) fail("incomplete unicode escape")
                    val hex = source.substring(offset, offset + 4)
                    offset += 4
                    hex.toIntOrNull(16)?.toChar() ?: fail("invalid unicode escape")
                }
                else -> fail("invalid escape '$escaped'")
            }
        }

        private fun readNumber(): LegacyJson.NumberValue {
            val start = offset
            if (consume('-') && offset >= source.length) fail("incomplete number")
            if (consume('0')) {
                if (offset < source.length && source[offset].isDigit()) fail("leading zero in number")
            } else {
                readDigits()
            }
            if (consume('.')) readDigits()
            if (offset < source.length && source[offset] in "eE") {
                offset += 1
                if (offset < source.length && source[offset] in "+-") offset += 1
                readDigits()
            }
            val number = source.substring(start, offset)
            number.toBigDecimalOrNull() ?: fail("invalid number")
            return LegacyJson.NumberValue(number)
        }

        private fun readDigits() {
            val start = offset
            while (offset < source.length && source[offset].isDigit()) offset += 1
            if (start == offset) fail("expected digit")
        }

        private fun <T : LegacyJson> readLiteral(literal: String, value: T): T {
            if (!source.startsWith(literal, offset)) fail("expected $literal")
            offset += literal.length
            return value
        }

        private fun skipWhitespace() {
            while (offset < source.length && source[offset] in " \t\r\n") offset += 1
        }

        private fun consume(expected: Char): Boolean {
            if (offset >= source.length || source[offset] != expected) return false
            offset += 1
            return true
        }

        private fun expect(expected: Char) {
            if (!consume(expected)) fail("expected '$expected'")
        }

        private fun fail(message: String): Nothing {
            throw LegacyJsonException("$message at offset $offset")
        }
    }
}

internal fun LegacyJson.render(): String = when (this) {
    is LegacyJson.Object -> values.entries.joinToString(prefix = "{", postfix = "}") { (key, value) ->
        "${key.jsonQuoted()}:${value.render()}"
    }
    is LegacyJson.Array -> values.joinToString(prefix = "[", postfix = "]") { it.render() }
    is LegacyJson.StringValue -> value.jsonQuoted()
    is LegacyJson.NumberValue -> source
    is LegacyJson.BooleanValue -> value.toString()
    LegacyJson.NullValue -> "null"
}

private fun String.jsonQuoted(): String = buildString {
    append('"')
    for (char in this@jsonQuoted) {
        when (char) {
            '"' -> append("\\\"")
            '\\' -> append("\\\\")
            '\b' -> append("\\b")
            '\u000c' -> append("\\f")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            else -> if (char.code < 0x20) append("\\u%04x".format(char.code)) else append(char)
        }
    }
    append('"')
}

internal fun LegacyJson.objectOrNull(): LegacyJson.Object? = this as? LegacyJson.Object
internal fun LegacyJson.arrayOrNull(): LegacyJson.Array? = this as? LegacyJson.Array
internal fun LegacyJson.stringOrNull(): String? = (this as? LegacyJson.StringValue)?.value
internal fun LegacyJson.longOrNull(): Long? = (this as? LegacyJson.NumberValue)?.source?.toLongOrNull()
internal fun LegacyJson.intOrNull(): Int? = longOrNull()?.takeIf { it in Int.MIN_VALUE..Int.MAX_VALUE }?.toInt()
internal fun LegacyJson.doubleOrNull(): Double? = (this as? LegacyJson.NumberValue)?.source?.toDoubleOrNull()
internal fun LegacyJson.booleanOrNull(): Boolean? = (this as? LegacyJson.BooleanValue)?.value
