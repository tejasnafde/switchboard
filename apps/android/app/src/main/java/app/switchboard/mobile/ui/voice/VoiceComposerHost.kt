package app.switchboard.mobile.ui.voice

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.LifecycleOwner
import app.switchboard.mobile.domain.voice.VoiceCancelable
import app.switchboard.mobile.domain.voice.VoiceComposerController
import app.switchboard.mobile.domain.voice.VoiceComposerControllerState
import app.switchboard.mobile.domain.voice.VoicePermissionDecision
import app.switchboard.mobile.domain.voice.VoicePermissionGateway
import app.switchboard.mobile.domain.voice.VoiceRefinementRequest
import app.switchboard.mobile.domain.voice.VoiceTranscriptRefiner
import app.switchboard.mobile.platform.voice.AndroidSpeechRecognizerGateway
import app.switchboard.mobile.platform.voice.AndroidVoicePermissionGateway
import app.switchboard.mobile.platform.voice.AndroidVoiceScheduler

class VoiceComposerBinding internal constructor(
    val state: VoiceComposerControllerState,
    val start: () -> Unit,
    val stop: () -> Unit,
    val cancel: () -> Unit,
    val lock: () -> Unit,
    val userEdited: (String) -> Unit,
    val openNoticeAction: () -> Boolean,
)

private data object UnavailableTranscriptRefiner : VoiceTranscriptRefiner {
    override val available: Boolean = false

    override fun transcribe(
        request: VoiceRefinementRequest,
        callback: (app.switchboard.mobile.domain.voice.VoiceRefinementResult) -> Unit,
    ): VoiceCancelable = VoiceCancelable {}
}

private class PermissionCallbackHolder {
    var callback: ((Boolean) -> Unit)? = null

    fun complete(granted: Boolean) {
        callback?.also { callback = null }?.invoke(granted)
    }
}

@Composable
fun rememberVoiceComposer(
    draft: String,
    onDraft: (String) -> Unit,
    projectPath: String = "",
    refiner: VoiceTranscriptRefiner = UnavailableTranscriptRefiner,
): VoiceComposerBinding {
    val context = LocalContext.current
    val activity = remember(context) { context.findActivity() }
    val lifecycleOwner = activity as? LifecycleOwner
    val callbackHolder = remember { PermissionCallbackHolder() }
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
        callbackHolder::complete,
    )
    val permission = remember(activity, permissionLauncher) {
        activity?.let {
            AndroidVoicePermissionGateway(it) { permissionName, callback ->
                callbackHolder.callback = callback
                permissionLauncher.launch(permissionName)
            }
        } ?: DeniedVoicePermissionGateway
    }
    val latestOnDraft by rememberUpdatedState(onDraft)
    var controllerState by remember(activity, projectPath, refiner) {
        mutableStateOf<VoiceComposerControllerState?>(null)
    }
    val controller = remember(activity, projectPath, refiner) {
        VoiceComposerController(
            initialDraft = draft,
            permission = permission,
            recognizer = AndroidSpeechRecognizerGateway(context),
            refiner = refiner,
            scheduler = AndroidVoiceScheduler(),
            projectPath = projectPath,
            onDraft = { latestOnDraft(it) },
            onState = { controllerState = it },
        ).also { controllerState = it.state }
    }

    LaunchedEffect(controller, draft) {
        if (controller.state.session.draft.text != draft) controller.userEdited(draft)
    }
    DisposableEffect(controller, activity, lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (
                event == Lifecycle.Event.ON_STOP &&
                VoiceLifecyclePolicy.shouldStopForBackground(
                    isChangingConfigurations = activity?.isChangingConfigurations == true,
                )
            ) {
                controller.onBackground()
            }
        }
        lifecycleOwner?.lifecycle?.addObserver(observer)
        onDispose {
            lifecycleOwner?.lifecycle?.removeObserver(observer)
            controller.close()
        }
    }

    val state = controllerState ?: controller.state
    return VoiceComposerBinding(
        state = state,
        start = controller::start,
        stop = controller::stop,
        cancel = controller::cancel,
        lock = controller::lock,
        userEdited = controller::userEdited,
        openNoticeAction = controller::openNoticeAction,
    )
}

private data object DeniedVoicePermissionGateway : VoicePermissionGateway {
    override fun request(callback: (VoicePermissionDecision) -> Unit) {
        callback(VoicePermissionDecision.Denied(canAskAgain = false))
    }

    override fun openSettings(): Boolean = false
}

private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}
