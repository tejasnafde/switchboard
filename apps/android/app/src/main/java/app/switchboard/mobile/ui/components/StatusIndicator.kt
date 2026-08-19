package app.switchboard.mobile.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

@Composable
fun StatusIndicator(
    tone: StatusTone,
    description: String? = null,
    modifier: Modifier = Modifier,
    size: Dp = 8.dp,
) {
    val semanticsModifier = if (description == null) {
        Modifier.clearAndSetSemantics { }
    } else {
        Modifier.semantics { contentDescription = description }
    }
    Box(
        modifier = modifier
            .size(size)
            .background(tone.indicatorColor, CircleShape)
            .then(semanticsModifier),
    )
}
