package app.switchboard.mobile.ui.thread

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.ClickableText
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.switchboard.mobile.ui.theme.Accent
import app.switchboard.mobile.ui.theme.GeistMono
import app.switchboard.mobile.ui.theme.SurfaceRaised
import app.switchboard.mobile.ui.theme.TextDim

@Composable
fun ThreadRichText(
    markdown: String,
    modifier: Modifier = Modifier,
) {
    val blocks = remember(markdown) { ThreadRichTextParser.parse(markdown) }
    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        blocks.forEach { block ->
            when (block) {
                is RichTextBlock.Paragraph -> RichInlineText(block.inlines)
                is RichTextBlock.Heading -> RichInlineText(
                    inlines = block.inlines,
                    style = when (block.level) {
                        1 -> MaterialTheme.typography.headlineSmall
                        2 -> MaterialTheme.typography.titleLarge
                        3 -> MaterialTheme.typography.titleMedium
                        else -> MaterialTheme.typography.titleSmall
                    }.copy(fontWeight = FontWeight.SemiBold),
                )
                is RichTextBlock.Code -> CodeBlock(block)
                is RichTextBlock.ListItem -> Row(
                    modifier = Modifier.padding(start = (block.depth * 14).dp),
                    verticalAlignment = Alignment.Top,
                ) {
                    Text(
                        block.marker,
                        color = TextDim,
                        fontFamily = GeistMono,
                        modifier = Modifier.width(28.dp),
                    )
                    RichInlineText(block.inlines, modifier = Modifier.weight(1f))
                }
                is RichTextBlock.Quote -> Row {
                    Box(
                        Modifier
                            .width(3.dp)
                            .height(28.dp)
                            .background(Accent),
                    )
                    RichInlineText(
                        block.inlines,
                        modifier = Modifier
                            .weight(1f)
                            .padding(start = 10.dp),
                        style = MaterialTheme.typography.bodyMedium.copy(
                            color = TextDim,
                            fontStyle = FontStyle.Italic,
                        ),
                    )
                }
                RichTextBlock.Rule -> Box(
                    Modifier
                        .fillMaxWidth()
                        .height(1.dp)
                        .background(TextDim),
                )
                is RichTextBlock.Table -> RichTable(block)
            }
        }
    }
}

@Composable
private fun CodeBlock(block: RichTextBlock.Code) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(SurfaceRaised)
            .padding(vertical = 9.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        block.language?.let {
            Text(
                it,
                color = TextDim,
                fontFamily = GeistMono,
                fontSize = 10.sp,
                modifier = Modifier.padding(horizontal = 10.dp),
            )
        }
        Text(
            block.text,
            fontFamily = GeistMono,
            fontSize = 12.sp,
            modifier = Modifier
                .horizontalScroll(rememberScrollState())
                .padding(horizontal = 10.dp),
        )
    }
}

@Composable
private fun RichTable(table: RichTextBlock.Table) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState()),
    ) {
        TableRow(table.header, table.alignments, header = true)
        table.rows.forEach { row -> TableRow(row, table.alignments, header = false) }
    }
}

@Composable
private fun TableRow(
    cells: List<List<RichInline>>,
    alignments: List<RichTextAlignment>,
    header: Boolean,
) {
    Row(modifier = Modifier.background(if (header) SurfaceRaised else Color.Transparent)) {
        cells.forEachIndexed { index, cell ->
            RichInlineText(
                inlines = cell,
                modifier = Modifier
                    .width(140.dp)
                    .padding(horizontal = 8.dp, vertical = 7.dp),
                style = MaterialTheme.typography.bodySmall.copy(
                    fontWeight = if (header) FontWeight.SemiBold else FontWeight.Normal,
                    textAlign = alignments.getOrNull(index).toTextAlign(),
                ),
            )
        }
    }
}

@Composable
private fun RichInlineText(
    inlines: List<RichInline>,
    modifier: Modifier = Modifier,
    style: TextStyle = MaterialTheme.typography.bodyMedium,
) {
    val uriHandler = LocalUriHandler.current
    val annotated = remember(inlines) { richAnnotatedString(inlines) }
    ClickableText(
        text = annotated,
        style = style.copy(color = style.color.takeUnless { it == Color.Unspecified }
            ?: MaterialTheme.colorScheme.onSurface),
        modifier = modifier,
        onClick = { offset ->
            annotated.getStringAnnotations("URL", offset, offset).firstOrNull()?.let { annotation ->
                runCatching { uriHandler.openUri(annotation.item) }
            }
        },
    )
}

private fun richAnnotatedString(inlines: List<RichInline>): AnnotatedString = buildAnnotatedString {
    fun appendInlines(values: List<RichInline>) {
        values.forEach { inline ->
            when (inline) {
                is RichInline.Text -> append(inline.text)
                is RichInline.Code -> withStyle(
                    SpanStyle(background = SurfaceRaised, fontFamily = GeistMono),
                ) { append(inline.text) }
                is RichInline.Strong -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) {
                    appendInlines(inline.children)
                }
                is RichInline.Emphasis -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) {
                    appendInlines(inline.children)
                }
                is RichInline.Strike -> withStyle(
                    SpanStyle(textDecoration = TextDecoration.LineThrough),
                ) { appendInlines(inline.children) }
                is RichInline.Link -> {
                    pushStringAnnotation("URL", inline.href)
                    withStyle(SpanStyle(color = Accent, textDecoration = TextDecoration.Underline)) {
                        appendInlines(inline.children)
                    }
                    pop()
                }
            }
        }
    }
    appendInlines(inlines)
}

private fun RichTextAlignment?.toTextAlign(): TextAlign = when (this) {
    RichTextAlignment.CENTER -> TextAlign.Center
    RichTextAlignment.RIGHT -> TextAlign.End
    else -> TextAlign.Start
}
