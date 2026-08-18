package app.switchboard.mobile.ui.thread

import app.switchboard.mobile.domain.remote.ProviderSkill
import app.switchboard.mobile.domain.remote.RuntimeMode

sealed interface ThreadSlashSource {
    data object Switchboard : ThreadSlashSource
    data class Agent(val value: String) : ThreadSlashSource
}

sealed interface ThreadSlashAction {
    data class SetMode(val mode: RuntimeMode) : ThreadSlashAction
    data object ClearLocalFeed : ThreadSlashAction
    data object Interrupt : ThreadSlashAction
    data object AttachImage : ThreadSlashAction
    data class Insert(val text: String) : ThreadSlashAction
}

data class ThreadSlashCommand(
    val name: String,
    val description: String,
    val action: ThreadSlashAction,
    val source: ThreadSlashSource,
    val argumentHint: String? = null,
)

object ThreadSlashPolicy {
    val builtIns = listOf(
        ThreadSlashCommand(
            "plan",
            "Plan mode - read-only",
            ThreadSlashAction.SetMode(RuntimeMode.Plan),
            ThreadSlashSource.Switchboard,
        ),
        ThreadSlashCommand(
            "sandbox",
            "Sandbox mode - approvals required",
            ThreadSlashAction.SetMode(RuntimeMode.Sandbox),
            ThreadSlashSource.Switchboard,
        ),
        ThreadSlashCommand(
            "edits",
            "Accept edits automatically",
            ThreadSlashAction.SetMode(RuntimeMode.AcceptEdits),
            ThreadSlashSource.Switchboard,
        ),
        ThreadSlashCommand(
            "full",
            "Full access - no prompts",
            ThreadSlashAction.SetMode(RuntimeMode.FullAccess),
            ThreadSlashSource.Switchboard,
        ),
        ThreadSlashCommand(
            "image",
            "Attach an image",
            ThreadSlashAction.AttachImage,
            ThreadSlashSource.Switchboard,
        ),
        ThreadSlashCommand(
            "stop",
            "Interrupt the current turn",
            ThreadSlashAction.Interrupt,
            ThreadSlashSource.Switchboard,
        ),
        ThreadSlashCommand(
            "clear",
            "Clear this feed on this phone",
            ThreadSlashAction.ClearLocalFeed,
            ThreadSlashSource.Switchboard,
        ),
    )

    fun query(draft: String): String? = Regex("^/([^\\s/]*)$")
        .matchEntire(draft)
        ?.groupValues
        ?.get(1)

    fun commands(skills: List<ProviderSkill>): List<ThreadSlashCommand> {
        val taken = builtIns.mapTo(mutableSetOf()) { it.name.lowercase() }
        val agent = skills.mapNotNull { skill ->
            val name = skill.name.removePrefix("/")
            val key = name.lowercase()
            if (name.isBlank() || !taken.add(key)) return@mapNotNull null
            ThreadSlashCommand(
                name = name,
                description = skill.description.orEmpty(),
                action = ThreadSlashAction.Insert("/$name "),
                source = ThreadSlashSource.Agent(skill.source),
                argumentHint = skill.argumentHint,
            )
        }
        return builtIns + agent
    }

    fun filter(commands: List<ThreadSlashCommand>, query: String): List<ThreadSlashCommand> {
        val normalized = query.trim().lowercase()
        if (normalized.isEmpty()) return commands
        return commands.mapIndexedNotNull { index, command ->
            val name = command.name.lowercase()
            val rank = when {
                name.startsWith(normalized) -> 0
                normalized in name -> 1
                else -> return@mapIndexedNotNull null
            }
            RankedSlashCommand(command, rank, index)
        }.sortedWith(compareBy<RankedSlashCommand> { it.rank }.thenBy { it.index })
            .map(RankedSlashCommand::command)
    }

    private data class RankedSlashCommand(
        val command: ThreadSlashCommand,
        val rank: Int,
        val index: Int,
    )
}
