package app.switchboard.mobile.domain.iap

data class IapDiscoveredTarget(
    val alias: String,
    val instance: String,
    val project: String,
    val zone: String,
)

data class IapTarget(
    val project: String,
    val zone: String,
    val instance: String,
    val port: Int,
    val networkInterface: String = "nic0",
)

data class IapTargetSelection(
    val available: List<IapDiscoveredTarget>,
    val discoveredCount: Int,
    val alreadyAddedCount: Int,
)

object IapTargetDiscovery {
    fun merge(sources: List<List<IapDiscoveredTarget>>): List<IapDiscoveredTarget> {
        val seen = mutableSetOf<String>()
        return buildList {
            for (source in sources) {
                for (target in source) {
                    val key = "${target.project}\u0000${target.zone}\u0000${target.instance}"
                    if (seen.add(key)) add(target)
                }
            }
        }
    }

    fun select(
        sources: List<List<IapDiscoveredTarget>>,
        saved: List<IapTarget>,
    ): IapTargetSelection {
        val discovered = mergeNormalized(sources)
        val savedKeys = saved.mapTo(mutableSetOf(), ::key)
        val available = discovered.filterNot { key(it) in savedKeys }
        return IapTargetSelection(
            available = available,
            discoveredCount = discovered.size,
            alreadyAddedCount = discovered.size - available.size,
        )
    }

    private fun mergeNormalized(sources: List<List<IapDiscoveredTarget>>): List<IapDiscoveredTarget> {
        val seen = mutableSetOf<String>()
        return buildList {
            for (source in sources) {
                for (target in source) {
                    if (seen.add(key(target))) add(target)
                }
            }
        }
    }

    private fun key(target: IapDiscoveredTarget): String = listOf(
        target.project,
        target.zone,
        target.instance,
    ).joinToString("\u0000") { it.trim().lowercase() }

    private fun key(target: IapTarget): String = listOf(
        target.project,
        target.zone,
        target.instance,
    ).joinToString("\u0000") { it.trim().lowercase() }
}

sealed interface IapManualTargetResult {
    data class Valid(val target: IapTarget) : IapManualTargetResult
    data class Invalid(val field: String) : IapManualTargetResult
}

object IapManualTargetPolicy {
    fun validate(
        project: String,
        zone: String,
        instance: String,
        port: String,
    ): IapManualTargetResult {
        val normalizedProject = project.trim()
        if (normalizedProject.isEmpty()) return IapManualTargetResult.Invalid("project")
        val normalizedZone = zone.trim()
        if (normalizedZone.isEmpty()) return IapManualTargetResult.Invalid("zone")
        val normalizedInstance = instance.trim()
        if (normalizedInstance.isEmpty()) return IapManualTargetResult.Invalid("instance")
        val normalizedPort = port.trim().toIntOrNull()
            ?.takeIf { it in 1..65_535 }
            ?: return IapManualTargetResult.Invalid("port")
        return IapManualTargetResult.Valid(
            IapTarget(normalizedProject, normalizedZone, normalizedInstance, normalizedPort),
        )
    }
}
