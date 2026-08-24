package app.switchboard.mobile.data.remote

import app.switchboard.mobile.domain.remote.WorktreeCreationError
import app.switchboard.mobile.domain.remote.WorktreeCreationOwner
import app.switchboard.mobile.domain.remote.WorktreeCreationPhase
import app.switchboard.mobile.domain.remote.WorktreeCreationRecoveryAction
import app.switchboard.mobile.domain.remote.WorktreeCreationRequest
import app.switchboard.mobile.domain.remote.WorktreeCreationSnapshot
import app.switchboard.mobile.domain.remote.WorktreeCleanupDisposition
import app.switchboard.mobile.domain.remote.WorktreeCreationStatus
import app.switchboard.mobile.domain.remote.WorktreeLaunchAgent
import app.switchboard.mobile.domain.remote.WorktreeSetupPolicy
import app.switchboard.mobile.domain.remote.WorktreeStartupReceipt
import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue

object WorktreeCreationWire {
    fun encodeRequest(request: WorktreeCreationRequest): JsonObject = obj(
        "schemaVersion" to JsonNumber("1"),
        "creationId" to JsonString(request.creationId),
        "repository" to obj(
            "projectPath" to JsonString(request.projectPath),
            "machineId" to JsonString(request.machineId),
        ),
        "checkout" to obj(
            "baseRef" to JsonString(request.baseRef),
            "branch" to obj(
                "namespace" to JsonString("sb"),
                "seed" to JsonString(request.branchSeed),
            ),
            "location" to JsonString("managed-in-repo"),
        ),
        "owner" to encodeOwner(request.owner),
        "purpose" to JsonString("new-chat"),
        "setup" to obj("policy" to JsonString(request.setupPolicy.wire)),
        "launch" to obj("initialAgent" to encodeLaunch(request.launchAgent)),
        "provenance" to obj(
            "surface" to JsonString("android"),
            "machineId" to JsonString(request.machineId),
            "requestedAt" to JsonNumber(request.requestedAt.toString()),
        ),
    )

    fun decodeRequest(value: JsonValue?): WorktreeCreationRequest {
        val root = value.objectRequired("worktree creation request")
        require(root.longRequired("schemaVersion") == 1L) { "Unsupported worktree creation schema" }
        val repository = root.objectRequired("repository")
        val checkout = root.objectRequired("checkout")
        val branch = checkout.objectRequired("branch")
        val setup = root.objectRequired("setup")
        val launch = root.objectRequired("launch").objectRequired("initialAgent")
        val provenance = root.objectRequired("provenance")
        return WorktreeCreationRequest(
            creationId = root.stringRequired("creationId"),
            machineId = repository.stringRequired("machineId"),
            projectPath = repository.stringRequired("projectPath"),
            baseRef = checkout.stringRequired("baseRef"),
            branchSeed = branch.stringRequired("seed"),
            owner = decodeOwner(root.objectRequired("owner")),
            setupPolicy = setupPolicyFromWire(setup.stringRequired("policy")),
            launchAgent = WorktreeLaunchAgent(
                provider = launch.stringRequired("provider"),
                runtimeMode = launch.stringRequired("runtimeMode"),
                model = launch.string("model"),
                instanceId = launch.string("instanceId"),
                prompt = launch.string("prompt"),
            ),
            requestedAt = provenance.longRequired("requestedAt"),
        )
    }

    fun decodeSnapshot(value: JsonValue?): WorktreeCreationSnapshot {
        val root = value.objectRequired("worktree creation snapshot")
        return WorktreeCreationSnapshot(
            creationId = root.stringRequired("creationId"),
            phase = phaseFromWire(root.stringRequired("phase")),
            projectPath = root.stringRequired("projectPath"),
            worktreeId = root.string("worktreeId"),
            worktreePath = root.string("worktreePath"),
            branch = root.string("branch"),
            baseRef = root.stringRequired("baseRef"),
            owner = decodeOwner(root.objectRequired("owner")),
            status = statusFromWire(root.stringRequired("status")),
            revision = root.longRequired("revision"),
            startupReceipt = root.objectValue("startupReceipt")?.let(::decodeStartupReceipt),
            recoveryActions = root.array("recoveryActions").map { action ->
                recoveryActionFromWire(
                    (action as? JsonString)?.value ?: error("Expected worktree recovery action string"),
                )
            },
            error = root.objectValue("error")?.let { error ->
                WorktreeCreationError(
                    code = error.stringRequired("code"),
                    message = error.stringRequired("message"),
                    retryable = error.booleanRequired("retryable"),
                )
            },
            cleanupDisposition = root.string("cleanupDisposition")?.let(::cleanupDispositionFromWire),
        )
    }

    fun encodeGet(creationId: String, machineId: String): JsonObject = obj(
        "creationId" to JsonString(creationId),
        "machineId" to JsonString(machineId),
    )

    fun encodeAction(
        creationId: String,
        machineId: String,
        expectedRevision: Long,
        action: WorktreeCreationRecoveryAction,
    ): JsonObject = obj(
        "creationId" to JsonString(creationId),
        "machineId" to JsonString(machineId),
        "expectedRevision" to JsonNumber(expectedRevision.toString()),
        "action" to JsonString(action.wire),
    )

    fun progressCreationId(args: JsonArray): String? =
        (args.values.firstOrNull() as? JsonObject)?.string("creationId")

    private fun encodeOwner(owner: WorktreeCreationOwner): JsonObject = when (owner) {
        is WorktreeCreationOwner.Conversation -> obj(
            "kind" to JsonString("conversation"),
            "conversationId" to JsonString(owner.conversationId),
            "agentType" to JsonString(owner.agentType),
        )
    }

    private fun decodeOwner(value: JsonObject): WorktreeCreationOwner {
        require(value.stringRequired("kind") == "conversation") {
            "Android new-session worktrees require a conversation owner"
        }
        return WorktreeCreationOwner.Conversation(
            conversationId = value.stringRequired("conversationId"),
            agentType = value.stringRequired("agentType"),
        )
    }

    private fun encodeLaunch(launch: WorktreeLaunchAgent): JsonObject {
        val values = linkedMapOf<String, JsonValue>(
            "provider" to JsonString(launch.provider),
            "runtimeMode" to JsonString(launch.runtimeMode),
        )
        launch.model?.let { values["model"] = JsonString(it) }
        launch.instanceId?.let { values["instanceId"] = JsonString(it) }
        launch.prompt?.let { values["prompt"] = JsonString(it) }
        return JsonObject(values)
    }

    private fun decodeStartupReceipt(value: JsonObject) = WorktreeStartupReceipt(
        status = startupStatusFromWire(value.stringRequired("status")),
        terminalIds = value.array("terminalIds").map { id ->
            (id as? JsonString)?.value ?: error("Expected worktree terminal id string")
        },
        providerThreadId = value.string("providerThreadId"),
        initialPromptOrigin = value.string("initialPromptOrigin"),
    )

    private val WorktreeSetupPolicy.wire: String
        get() = when (this) {
            WorktreeSetupPolicy.Inherit -> "inherit"
            WorktreeSetupPolicy.Run -> "run"
            WorktreeSetupPolicy.Skip -> "skip"
        }

    private fun setupPolicyFromWire(value: String): WorktreeSetupPolicy = when (value) {
        "inherit" -> WorktreeSetupPolicy.Inherit
        "run" -> WorktreeSetupPolicy.Run
        "skip" -> WorktreeSetupPolicy.Skip
        else -> error("Unknown worktree setup policy $value")
    }

    private fun phaseFromWire(value: String): WorktreeCreationPhase = when (value) {
        "pending" -> WorktreeCreationPhase.Pending
        "materializing" -> WorktreeCreationPhase.Materializing
        "configuring" -> WorktreeCreationPhase.Configuring
        "linking" -> WorktreeCreationPhase.Linking
        "awaiting_setup_decision" -> WorktreeCreationPhase.AwaitingSetupDecision
        "provisioning" -> WorktreeCreationPhase.Provisioning
        "ready" -> WorktreeCreationPhase.Ready
        else -> error("Unknown worktree creation phase $value")
    }

    private fun statusFromWire(value: String): WorktreeCreationStatus = when (value) {
        "pending" -> WorktreeCreationStatus.Pending
        "ready" -> WorktreeCreationStatus.Ready
        "failed" -> WorktreeCreationStatus.Failed
        "rolled_back" -> WorktreeCreationStatus.RolledBack
        "cleanup_required" -> WorktreeCreationStatus.CleanupRequired
        "cancelled" -> WorktreeCreationStatus.Cancelled
        else -> error("Unknown worktree creation status $value")
    }

    private val WorktreeCreationRecoveryAction.wire: String
        get() = when (this) {
            WorktreeCreationRecoveryAction.ChooseSetupRun -> "choose_setup_run"
            WorktreeCreationRecoveryAction.ChooseSetupSkip -> "choose_setup_skip"
            WorktreeCreationRecoveryAction.Retry -> "retry"
            WorktreeCreationRecoveryAction.Cancel -> "cancel"
            WorktreeCreationRecoveryAction.Retain -> "retain"
            WorktreeCreationRecoveryAction.Remove -> "remove"
            WorktreeCreationRecoveryAction.StartInProject -> "start_in_project"
        }

    private fun recoveryActionFromWire(
        value: String,
    ): WorktreeCreationRecoveryAction = when (value) {
        "choose_setup_run" -> WorktreeCreationRecoveryAction.ChooseSetupRun
        "choose_setup_skip" -> WorktreeCreationRecoveryAction.ChooseSetupSkip
        "retry" -> WorktreeCreationRecoveryAction.Retry
        "cancel" -> WorktreeCreationRecoveryAction.Cancel
        "retain" -> WorktreeCreationRecoveryAction.Retain
        "remove" -> WorktreeCreationRecoveryAction.Remove
        "start_in_project" -> WorktreeCreationRecoveryAction.StartInProject
        else -> error("Unknown worktree recovery action $value")
    }

    private fun startupStatusFromWire(value: String): WorktreeStartupReceipt.Status =
        when (value) {
            "not_requested" -> WorktreeStartupReceipt.Status.NotRequested
            "running" -> WorktreeStartupReceipt.Status.Running
            "succeeded" -> WorktreeStartupReceipt.Status.Succeeded
            "failed" -> WorktreeStartupReceipt.Status.Failed
            "ambiguous" -> WorktreeStartupReceipt.Status.Ambiguous
            else -> error("Unknown worktree startup status $value")
        }

    private fun cleanupDispositionFromWire(value: String): WorktreeCleanupDisposition = when (value) {
        "retained" -> WorktreeCleanupDisposition.Retained
        "removed" -> WorktreeCleanupDisposition.Removed
        "removal_refused" -> WorktreeCleanupDisposition.RemovalRefused
        else -> error("Unknown worktree cleanup disposition $value")
    }

    private fun JsonValue?.objectRequired(label: String): JsonObject =
        this as? JsonObject ?: error("Expected $label object")

    private fun JsonObject.objectRequired(key: String): JsonObject =
        values[key].objectRequired(key)

    private fun JsonObject.objectValue(key: String): JsonObject? = when (val value = values[key]) {
        null, JsonNull -> null
        is JsonObject -> value
        else -> error("Expected $key object")
    }

    private fun JsonObject.stringRequired(key: String): String =
        string(key) ?: error("Expected $key string")

    private fun JsonObject.string(key: String): String? = when (val value = values[key]) {
        null, JsonNull -> null
        is JsonString -> value.value
        else -> error("Expected $key string")
    }

    private fun JsonObject.longRequired(key: String): Long =
        (values[key] as? JsonNumber)?.source?.toLongOrNull() ?: error("Expected $key integer")

    private fun JsonObject.booleanRequired(key: String): Boolean =
        (values[key] as? app.switchboard.mobile.protocol.JsonBoolean)?.value
            ?: error("Expected $key boolean")

    private fun JsonObject.array(key: String): List<JsonValue> = when (val value = values[key]) {
        null, JsonNull -> emptyList()
        is JsonArray -> value.values
        else -> error("Expected $key array")
    }

    private fun obj(vararg fields: Pair<String, JsonValue>): JsonObject =
        JsonObject(linkedMapOf(*fields))
}
