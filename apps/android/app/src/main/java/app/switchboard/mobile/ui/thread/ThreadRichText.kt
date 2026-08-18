package app.switchboard.mobile.ui.thread

enum class RichTextAlignment {
    LEFT,
    CENTER,
    RIGHT,
    NONE,
}

sealed interface RichInline {
    val plainText: String

    data class Text(val text: String) : RichInline {
        override val plainText = text
    }

    data class Code(val text: String) : RichInline {
        override val plainText = text
    }

    data class Strong(val children: List<RichInline>) : RichInline {
        override val plainText = children.plainText()
    }

    data class Emphasis(val children: List<RichInline>) : RichInline {
        override val plainText = children.plainText()
    }

    data class Strike(val children: List<RichInline>) : RichInline {
        override val plainText = children.plainText()
    }

    data class Link(val href: String, val children: List<RichInline>) : RichInline {
        override val plainText = children.plainText()
    }
}

fun List<RichInline>.plainText(): String = joinToString(separator = "") { it.plainText }

sealed interface RichTextBlock {
    data class Paragraph(val inlines: List<RichInline>) : RichTextBlock

    data class Heading(val level: Int, val inlines: List<RichInline>) : RichTextBlock {
        val plainText = inlines.plainText()
    }

    data class Code(val language: String?, val text: String) : RichTextBlock
    data class ListItem(
        val ordered: Boolean,
        val marker: String,
        val depth: Int,
        val inlines: List<RichInline>,
    ) : RichTextBlock
    data class Quote(val inlines: List<RichInline>) : RichTextBlock
    data object Rule : RichTextBlock
    data class Table(
        val header: List<List<RichInline>>,
        val rows: List<List<List<RichInline>>>,
        val alignments: List<RichTextAlignment>,
    ) : RichTextBlock
}

object ThreadRichTextParser {
    private val fence = Regex("^\\s{0,3}(`{3,}|~{3,})\\s*([A-Za-z0-9_+\\-]*)\\s*$")
    private val heading = Regex("^\\s{0,3}(#{1,6})\\s+(.*)$")
    private val rule = Regex("^\\s{0,3}([-*_])(?:\\s*\\1){2,}\\s*$")
    private val bullet = Regex("^(\\s*)[-*+]\\s+(.*)$")
    private val ordered = Regex("^(\\s*)(\\d{1,9})[.)]\\s+(.*)$")
    private val quote = Regex("^\\s{0,3}>\\s?(.*)$")
    private val inlineCode = Regex("`+([^`]+?)`+")
    private val inlineLink = Regex("\\[([^]]*)]\\(([^)\\s]+)[^)]*\\)")
    private val inlineStrong = Regex("\\*\\*(\\S|\\S[\\s\\S]*?\\S)\\*\\*")
    private val inlineStrike = Regex("~~(\\S|\\S[\\s\\S]*?\\S)~~")
    private val inlineStarEmphasis = Regex("\\*(\\S|\\S[^*\\n]*?\\S)\\*")
    private val inlineUnderscoreEmphasis = Regex("_(\\S|\\S[^_\\n]*?\\S)_(?![A-Za-z0-9])")
    private val inlineUrl = Regex("https?://[^\\s<>()]+")

    fun parse(source: String): List<RichTextBlock> {
        val lines = source.replace("\r\n", "\n").replace('\r', '\n').split('\n')
        val blocks = mutableListOf<RichTextBlock>()
        var index = 0
        while (index < lines.size) {
            val line = lines[index]
            if (line.isBlank()) {
                index += 1
                continue
            }
            val openingFence = fence.matchEntire(line)
            if (openingFence != null) {
                val marker = openingFence.groupValues[1].first()
                val body = mutableListOf<String>()
                index += 1
                while (index < lines.size) {
                    val closing = fence.matchEntire(lines[index])
                    if (closing != null && closing.groupValues[1].first() == marker) {
                        index += 1
                        break
                    }
                    body += lines[index]
                    index += 1
                }
                blocks += RichTextBlock.Code(
                    openingFence.groupValues[2].ifBlank { null },
                    body.joinToString("\n"),
                )
                continue
            }
            val headingMatch = heading.matchEntire(line)
            if (headingMatch != null) {
                blocks += RichTextBlock.Heading(
                    headingMatch.groupValues[1].length,
                    parseInline(headingMatch.groupValues[2].trim()),
                )
                index += 1
                continue
            }
            if (isTableStart(lines, index)) {
                val headerCells = splitTableRow(line).map(::parseInline)
                val alignments = splitTableRow(lines[index + 1]).map(::alignment)
                val rows = mutableListOf<List<List<RichInline>>>()
                index += 2
                while (index < lines.size && lines[index].contains('|') && !startsBlock(lines[index])) {
                    rows += splitTableRow(lines[index]).map(::parseInline)
                    index += 1
                }
                blocks += RichTextBlock.Table(headerCells, rows, alignments)
                continue
            }
            if (rule.matches(line)) {
                blocks += RichTextBlock.Rule
                index += 1
                continue
            }
            val quoteMatch = quote.matchEntire(line)
            if (quoteMatch != null) {
                val parts = mutableListOf(quoteMatch.groupValues[1])
                index += 1
                while (index < lines.size) {
                    val next = quote.matchEntire(lines[index]) ?: break
                    parts += next.groupValues[1]
                    index += 1
                }
                blocks += RichTextBlock.Quote(parseInline(parts.joinToString("\n").trim()))
                continue
            }
            val bulletMatch = bullet.matchEntire(line)
            if (bulletMatch != null) {
                blocks += RichTextBlock.ListItem(
                    ordered = false,
                    marker = "•",
                    depth = bulletMatch.groupValues[1].length / 2,
                    inlines = parseInline(bulletMatch.groupValues[2]),
                )
                index += 1
                continue
            }
            val orderedMatch = ordered.matchEntire(line)
            if (orderedMatch != null) {
                blocks += RichTextBlock.ListItem(
                    ordered = true,
                    marker = "${orderedMatch.groupValues[2]}.",
                    depth = orderedMatch.groupValues[1].length / 2,
                    inlines = parseInline(orderedMatch.groupValues[3]),
                )
                index += 1
                continue
            }
            val paragraph = mutableListOf(line)
            index += 1
            while (index < lines.size && lines[index].isNotBlank() && !startsBlock(lines[index])) {
                if (isTableStart(lines, index)) break
                paragraph += lines[index]
                index += 1
            }
            blocks += RichTextBlock.Paragraph(parseInline(paragraph.joinToString("\n").trim()))
        }
        return blocks
    }

    fun parseInline(source: String, depth: Int = 0): List<RichInline> {
        if (source.isEmpty()) return emptyList()
        if (depth > 4) return listOf(RichInline.Text(source))
        val output = mutableListOf<RichInline>()
        val plain = StringBuilder()
        fun flushPlain() {
            if (plain.isNotEmpty()) {
                output += RichInline.Text(plain.toString())
                plain.clear()
            }
        }
        var index = 0
        while (index < source.length) {
            val token = inlineToken(source, index, depth)
            if (token == null) {
                plain.append(source[index])
                index += 1
            } else {
                flushPlain()
                output += token.first
                index += token.second
            }
        }
        flushPlain()
        return output
    }

    private fun inlineToken(source: String, index: Int, depth: Int): Pair<RichInline, Int>? {
        inlineCode.matchAt(source, index)?.let {
            return RichInline.Code(it.groupValues[1]) to it.value.length
        }
        inlineLink.matchAt(source, index)?.let {
            return RichInline.Link(it.groupValues[2], parseInline(it.groupValues[1], depth + 1)) to
                it.value.length
        }
        inlineStrong.matchAt(source, index)?.let {
            return RichInline.Strong(parseInline(it.groupValues[1], depth + 1)) to it.value.length
        }
        inlineStrike.matchAt(source, index)?.let {
            return RichInline.Strike(parseInline(it.groupValues[1], depth + 1)) to it.value.length
        }
        inlineStarEmphasis.matchAt(source, index)?.let {
            return RichInline.Emphasis(parseInline(it.groupValues[1], depth + 1)) to it.value.length
        }
        inlineUnderscoreEmphasis.matchAt(source, index)?.let {
            return RichInline.Emphasis(parseInline(it.groupValues[1], depth + 1)) to it.value.length
        }
        inlineUrl.matchAt(source, index)?.let {
            return RichInline.Link(it.value, listOf(RichInline.Text(it.value))) to it.value.length
        }
        return null
    }

    private fun startsBlock(line: String): Boolean =
        fence.matches(line) || heading.matches(line) || rule.matches(line) ||
            bullet.matches(line) || ordered.matches(line) || quote.matches(line)

    private fun isTableStart(lines: List<String>, index: Int): Boolean {
        if (index + 1 >= lines.size || !lines[index].contains('|') || !lines[index + 1].contains('|')) {
            return false
        }
        val header = splitTableRow(lines[index])
        val delimiter = splitTableRow(lines[index + 1])
        return header.size == delimiter.size && delimiter.all { Regex("^:?-+:?$").matches(it) }
    }

    private fun splitTableRow(line: String): List<String> {
        val source = line.trim().removePrefix("|").removeSuffix("|")
        val cells = mutableListOf<String>()
        val cell = StringBuilder()
        var index = 0
        while (index < source.length) {
            if (source[index] == '\\' && source.getOrNull(index + 1) == '|') {
                cell.append('|')
                index += 2
            } else if (source[index] == '|') {
                cells += cell.toString().trim()
                cell.clear()
                index += 1
            } else {
                cell.append(source[index])
                index += 1
            }
        }
        cells += cell.toString().trim()
        return cells
    }

    private fun alignment(delimiter: String): RichTextAlignment = when {
        delimiter.startsWith(':') && delimiter.endsWith(':') -> RichTextAlignment.CENTER
        delimiter.endsWith(':') -> RichTextAlignment.RIGHT
        delimiter.startsWith(':') -> RichTextAlignment.LEFT
        else -> RichTextAlignment.NONE
    }
}
