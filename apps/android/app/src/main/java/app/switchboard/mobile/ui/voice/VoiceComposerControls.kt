package app.switchboard.mobile.ui.voice

import android.os.Handler
import android.os.Looper
import android.view.MotionEvent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInteropFilter
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.switchboard.mobile.domain.voice.VoiceGestureOutcome
import app.switchboard.mobile.domain.voice.VoiceGesturePolicy
import app.switchboard.mobile.domain.voice.VoiceNoticeAction
import app.switchboard.mobile.domain.voice.VoiceCapturePhase
import app.switchboard.mobile.ui.theme.Amber
import app.switchboard.mobile.ui.theme.Red
import app.switchboard.mobile.ui.theme.TextDim

private data class ThreadVoiceInputs(
    val mode: VoicePrimaryMode,
    val start: () -> Unit,
    val stopDictation: () -> Unit,
    val cancelDictation: () -> Unit,
    val lockDictation: () -> Unit,
    val send: () -> Unit,
    val stopAgent: () -> Unit,
)

private class ThreadGestureMemory {
    var active = false
    var mode = VoicePrimaryMode.Microphone
    var downX = 0f
    var downY = 0f
    var holdStarted = false
    var outcome = VoiceGestureOutcome.None
    var holdTask: Runnable? = null
}

@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun ThreadVoicePrimaryControl(
    voice: VoiceComposerBinding,
    canSend: Boolean,
    agentRunning: Boolean,
    enabled: Boolean,
    onSend: () -> Unit,
    onStopAgent: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val mode = VoicePrimaryActionPolicy.mode(
        canSend = canSend,
        agentRunning = agentRunning,
        listening = voice.state.session.listening,
        locked = voice.state.session.phase == VoiceCapturePhase.ListeningLocked,
    )
    val currentInputs by rememberUpdatedState(
        ThreadVoiceInputs(
            mode = mode,
            start = voice.start,
            stopDictation = voice.stop,
            cancelDictation = voice.cancel,
            lockDictation = voice.lock,
            send = onSend,
            stopAgent = onStopAgent,
        ),
    )
    val density = LocalDensity.current.density
    val handler = remember { Handler(Looper.getMainLooper()) }
    val memory = remember { ThreadGestureMemory() }
    var pressed by remember { mutableStateOf(false) }
    var gesture by remember { mutableStateOf(VoiceGestureOutcome.None) }

    fun perform(action: VoiceReleaseAction, inputs: ThreadVoiceInputs) {
        when (action) {
            VoiceReleaseAction.None -> Unit
            VoiceReleaseAction.Send -> inputs.send()
            VoiceReleaseAction.StopAgent -> inputs.stopAgent()
            VoiceReleaseAction.StopDictation -> inputs.stopDictation()
            VoiceReleaseAction.LockDictation -> inputs.lockDictation()
            VoiceReleaseAction.CancelDictation -> inputs.cancelDictation()
        }
    }

    val label = when (mode) {
        VoicePrimaryMode.Microphone -> "Mic"
        VoicePrimaryMode.Send -> "Send"
        VoicePrimaryMode.StopAgent -> "Stop"
        VoicePrimaryMode.StopDictation -> "Stop mic"
    }
    val hint = when {
        gesture == VoiceGestureOutcome.Cancelled -> "Release to cancel"
        gesture == VoiceGestureOutcome.Locked -> "Release to lock"
        voice.state.session.phase == VoiceCapturePhase.ListeningLocked -> "Listening · tap Stop mic"
        pressed && memory.holdStarted -> "Listening · release to stop"
        pressed -> "Keep holding…"
        mode == VoicePrimaryMode.Microphone -> "Hold to talk · slide up to lock · sideways to cancel"
        else -> null
    }

    Column(modifier = modifier, horizontalAlignment = Alignment.End) {
        hint?.let {
            Text(
                text = it,
                color = when (gesture) {
                    VoiceGestureOutcome.Cancelled -> Red
                    VoiceGestureOutcome.Locked -> Amber
                    VoiceGestureOutcome.None -> TextDim
                },
                style = MaterialTheme.typography.labelSmall,
                modifier = Modifier.padding(bottom = 4.dp),
            )
        }
        Text(
            text = label,
            color = MaterialTheme.colorScheme.onPrimary,
            style = MaterialTheme.typography.labelLarge,
            modifier = Modifier
                .heightIn(min = 48.dp)
                .clip(CircleShape)
                .background(
                    MaterialTheme.colorScheme.primary.copy(
                        alpha = if (pressed) 0.76f else 1f,
                    ),
                )
                .semantics {
                    role = Role.Button
                    onClick(label) {
                        val inputs = currentInputs
                        if (!enabled) return@onClick false
                        if (inputs.mode == VoicePrimaryMode.Microphone) {
                            inputs.start()
                            inputs.lockDictation()
                        } else {
                            perform(
                                VoicePrimaryActionPolicy.release(
                                    inputs.mode,
                                    holdStarted = false,
                                    VoiceGestureOutcome.None,
                                ),
                                inputs,
                            )
                        }
                        true
                    }
                }
                .pointerInteropFilter { event ->
                    if (!enabled) return@pointerInteropFilter false
                    when (event.actionMasked) {
                        MotionEvent.ACTION_DOWN -> {
                            val inputs = currentInputs
                            memory.active = true
                            memory.mode = inputs.mode
                            memory.downX = event.x
                            memory.downY = event.y
                            memory.holdStarted = false
                            memory.outcome = VoiceGestureOutcome.None
                            pressed = true
                            gesture = VoiceGestureOutcome.None
                            if (inputs.mode == VoicePrimaryMode.Microphone) {
                                Runnable {
                                    if (memory.active) {
                                        memory.holdStarted = true
                                        currentInputs.start()
                                    }
                                }.also {
                                    memory.holdTask = it
                                    handler.postDelayed(it, VoiceGesturePolicy.HoldMillis)
                                }
                            }
                            true
                        }

                        MotionEvent.ACTION_MOVE -> {
                            if (memory.active && memory.mode == VoicePrimaryMode.Microphone) {
                                memory.outcome = VoiceGesturePolicy.outcome(
                                    deltaX = (event.x - memory.downX) / density,
                                    deltaY = (event.y - memory.downY) / density,
                                )
                                gesture = memory.outcome
                            }
                            true
                        }

                        MotionEvent.ACTION_UP -> {
                            memory.holdTask?.let(handler::removeCallbacks)
                            val inputs = currentInputs
                            perform(
                                VoicePrimaryActionPolicy.release(
                                    modeAtPress = memory.mode,
                                    holdStarted = memory.holdStarted,
                                    gesture = memory.outcome,
                                ),
                                inputs,
                            )
                            memory.active = false
                            pressed = false
                            gesture = VoiceGestureOutcome.None
                            true
                        }

                        MotionEvent.ACTION_CANCEL -> {
                            memory.holdTask?.let(handler::removeCallbacks)
                            if (memory.holdStarted) {
                                if (voice.state.starting) currentInputs.lockDictation()
                                else currentInputs.cancelDictation()
                            }
                            memory.active = false
                            pressed = false
                            gesture = VoiceGestureOutcome.None
                            true
                        }

                        else -> memory.active
                    }
                }
                .padding(horizontal = 18.dp, vertical = 14.dp),
        )
    }
}

@Composable
fun NewSessionVoiceControl(
    voice: VoiceComposerBinding,
    enabled: Boolean,
    modifier: Modifier = Modifier,
) {
    val listening = voice.state.session.listening || voice.state.starting
    Button(
        onClick = {
            when (VoicePrimaryActionPolicy.tap(listening)) {
                VoiceTapAction.StartDictation -> voice.start()
                VoiceTapAction.StopDictation -> voice.stop()
            }
        },
        enabled = enabled,
        modifier = modifier.heightIn(min = 48.dp),
    ) {
        Text(if (listening) "Stop dictation" else "Dictate")
    }
}

@Composable
fun VoiceNoticeRow(
    voice: VoiceComposerBinding,
    modifier: Modifier = Modifier,
) {
    val notice = voice.state.notice ?: return
    Row(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(notice.message, color = Red, style = MaterialTheme.typography.labelSmall)
        notice.action?.let { action ->
            TextButton(onClick = { voice.openNoticeAction() }) {
                Text(
                    when (action) {
                        VoiceNoticeAction.RetryPermission -> "Try again"
                        VoiceNoticeAction.OpenSettings -> "Open settings"
                    },
                )
            }
        }
    }
}
