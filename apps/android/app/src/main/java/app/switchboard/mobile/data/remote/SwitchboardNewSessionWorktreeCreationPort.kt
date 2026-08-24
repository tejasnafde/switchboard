package app.switchboard.mobile.data.remote

import app.switchboard.mobile.domain.remote.RemoteOutcome
import app.switchboard.mobile.domain.remote.RemoteRequestKey
import app.switchboard.mobile.domain.remote.RemoteResponse
import app.switchboard.mobile.domain.remote.WorktreeCreationCommand
import app.switchboard.mobile.domain.remote.WorktreeCreationSnapshot
import java.io.Closeable

class SwitchboardNewSessionWorktreeCreationPort(
    private val client: SwitchboardRemoteClient,
) : NewSessionWorktreeCreationPort {
    override fun submit(
        command: WorktreeCreationCommand,
        callback: (app.switchboard.mobile.domain.remote.RemoteResponse<WorktreeCreationSnapshot>) -> Unit,
    ) {
        when (command) {
            is WorktreeCreationCommand.Ensure -> client.createWorktreeCreation(command.request, callback)
            is WorktreeCreationCommand.Act -> client.actOnWorktreeCreation(
                creationId = command.creationId,
                expectedRevision = command.expectedRevision,
                action = command.action,
                callback = callback,
            )
        }
    }

    override fun get(
        creationId: String,
        callback: (app.switchboard.mobile.domain.remote.RemoteResponse<WorktreeCreationSnapshot?>) -> Unit,
    ) {
        client.getWorktreeCreation(creationId, callback)
    }

    override fun observe(observer: (WorktreeCreationSnapshot) -> Unit): Closeable {
        val subscription = client.onWorktreeCreationProgress { creationId ->
            client.getWorktreeCreation(creationId) { response ->
                (response.outcome as? RemoteOutcome.Success)?.value?.let(observer)
            }
        }
        return Closeable(subscription::cancel)
    }
}

class UnavailableNewSessionWorktreeCreationPort(
    private val connectionId: String,
    private val generation: Long,
) : NewSessionWorktreeCreationPort {
    private val error = "Update the paired Switchboard desktop before resuming this worktree creation"

    override fun submit(
        command: WorktreeCreationCommand,
        callback: (RemoteResponse<WorktreeCreationSnapshot>) -> Unit,
    ) {
        callback(failure("worktree-creation:create"))
    }

    override fun get(
        creationId: String,
        callback: (RemoteResponse<WorktreeCreationSnapshot?>) -> Unit,
    ) {
        callback(failure("worktree-creation:get"))
    }

    override fun observe(observer: (WorktreeCreationSnapshot) -> Unit): Closeable = Closeable {}

    private fun <T> failure(operation: String) = RemoteResponse<T>(
        key = RemoteRequestKey(connectionId, generation, operation),
        outcome = RemoteOutcome.Failure(error),
    )
}
