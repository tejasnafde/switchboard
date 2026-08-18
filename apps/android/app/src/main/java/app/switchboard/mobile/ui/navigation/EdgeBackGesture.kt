package app.switchboard.mobile.ui.navigation

import androidx.compose.animation.core.animate
import androidx.compose.animation.core.spring
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerInputChange
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.platform.LocalDensity
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.max

object EdgeBackGesturePolicy {
    const val EdgeWidthDp = 32f
    const val ClaimDxDp = 12f
    const val Dominance = 1.5f
    const val CommitDxDp = 80f
    const val CommitVelocityDpPerSecond = 500f

    fun shouldClaim(startXDp: Float, dxDp: Float, dyDp: Float): Boolean =
        startXDp <= EdgeWidthDp &&
            dxDp >= ClaimDxDp &&
            dxDp > abs(dyDp) * Dominance

    fun commits(dxDp: Float, velocityXDpPerSecond: Float): Boolean =
        dxDp >= CommitDxDp || velocityXDpPerSecond >= CommitVelocityDpPerSecond
}

fun Modifier.edgeSwipeBack(
    enabled: Boolean,
    onBack: () -> Unit,
): Modifier = composed {
    val density = LocalDensity.current.density
    val currentOnBack by rememberUpdatedState(onBack)
    val animationScope = rememberCoroutineScope()
    var translationPx by remember { mutableFloatStateOf(0f) }

    graphicsLayer { translationX = translationPx }
        .pointerInput(enabled, density) {
            if (!enabled) {
                translationPx = 0f
                return@pointerInput
            }

            var resetJob: Job? = null
            try {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    if (down.position.x / density > EdgeBackGesturePolicy.EdgeWidthDp) {
                        return@awaitEachGesture
                    }

                    val start = down.position
                    val velocityTracker = VelocityTracker().apply {
                        addPosition(down.uptimeMillis, down.position)
                    }
                    var claimed = false
                    var lastChange: PointerInputChange = down

                    while (lastChange.pressed) {
                        val event = awaitPointerEvent()
                        val change = event.changes.firstOrNull { it.id == down.id }
                            ?: break
                        lastChange = change
                        velocityTracker.addPosition(change.uptimeMillis, change.position)

                        val delta = change.position - start
                        val dxDp = delta.x / density
                        val dyDp = delta.y / density

                        if (!claimed) {
                            if (change.isConsumed) break
                            claimed = EdgeBackGesturePolicy.shouldClaim(
                                startXDp = start.x / density,
                                dxDp = dxDp,
                                dyDp = dyDp,
                            )
                        }

                        if (claimed) {
                            resetJob?.cancel()
                            change.consume()
                            translationPx = max(0f, delta.x)
                        }
                    }

                    if (!claimed) return@awaitEachGesture

                    val delta = lastChange.position - start
                    val velocityDpPerSecond = velocityTracker.calculateVelocity().x / density
                    if (EdgeBackGesturePolicy.commits(delta.x / density, velocityDpPerSecond)) {
                        translationPx = 0f
                        currentOnBack()
                    } else {
                        resetJob = animationScope.launch {
                            animate(
                                initialValue = translationPx,
                                targetValue = 0f,
                                animationSpec = spring(dampingRatio = 1f),
                            ) { value, _ -> translationPx = value }
                        }
                    }
                }
            } finally {
                resetJob?.cancel()
                translationPx = 0f
            }
        }
}
