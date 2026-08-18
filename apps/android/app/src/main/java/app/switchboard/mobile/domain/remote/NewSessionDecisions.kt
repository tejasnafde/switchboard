package app.switchboard.mobile.domain.remote

data class ProviderOption(
    val kind: ProviderKind,
    val label: String,
    val agentType: String,
)

data class NewSessionModelOption(
    val id: String,
    val label: String,
    val tier: String,
    val authoritativeDefault: Boolean = false,
)

data class NewSessionSelection(
    val runtimeMode: RuntimeMode,
    val modelId: String?,
    val instanceId: String?,
    val modelOptions: List<NewSessionModelOption>,
)

object NewSessionDecisions {
    val providers = listOf(
        ProviderOption(ProviderKind.Claude, "Claude Code", "claude-code"),
        ProviderOption(ProviderKind.Codex, "Codex", "codex"),
        ProviderOption(ProviderKind.OpenCode, "OpenCode", "opencode"),
    )

    private val catalogs = mapOf(
        ProviderKind.Claude to listOf(
            model("claude-fable-5", "Claude Fable 5", "max"),
            model("claude-opus-5", "Claude Opus 5", "max"),
            model("claude-opus-4-8", "Claude Opus 4.8", "max"),
            model("claude-opus-4-7", "Claude Opus 4.7", "max"),
            model("claude-sonnet-5", "Claude Sonnet 5", "balanced"),
            model("claude-sonnet-4-6", "Claude Sonnet 4.6", "balanced"),
            model("claude-haiku-4-5", "Claude Haiku 4.5", "fast"),
        ),
        ProviderKind.Codex to listOf(
            model("gpt-5.6-sol", "GPT-5.6-Sol", "max"),
            model("gpt-5.6-terra", "GPT-5.6-Terra", "balanced"),
            model("gpt-5.6-luna", "GPT-5.6-Luna", "fast"),
            model("gpt-5.5", "GPT-5.5", "max"),
            model("gpt-5.4", "GPT-5.4", "max"),
            model("gpt-5.4-mini", "GPT-5.4-Mini", "fast"),
            model("gpt-5.2", "GPT-5.2", "balanced"),
        ),
        ProviderKind.OpenCode to listOf(
            model("nvidia-nim/z-ai/glm-5.1", "GLM 5.1 (NVIDIA, free)", "max"),
            model("nvidia-nim/moonshotai/kimi-k2.5", "Kimi K2.5 (NVIDIA, free)", "max"),
            model("nvidia-nim/minimaxai/minimax-m2.7", "MiniMax M2.7 (NVIDIA, free)", "balanced"),
            model("nvidia-nim/deepseek-ai/deepseek-v3_2", "DeepSeek V3.2 (NVIDIA, free)", "balanced"),
            model("google/gemini-2.5-pro", "Gemini 2.5 Pro", "max"),
            model("google/gemini-2.5-flash", "Gemini 2.5 Flash", "balanced"),
            model("google/gemini-2.0-flash-exp", "Gemini 2.0 Flash (exp)", "fast"),
            model("google/gemini-2.0-flash-thinking-exp", "Gemini 2.0 Flash Thinking", "balanced"),
            model("google/gemini-1.5-pro", "Gemini 1.5 Pro", "balanced"),
            model("google/gemini-1.5-flash", "Gemini 1.5 Flash", "fast"),
        ),
    )

    fun models(provider: ProviderKind): List<NewSessionModelOption> = catalogs.getValue(provider)

    fun profiles(
        instances: List<ProviderInstance>,
        provider: ProviderKind,
    ): List<ProviderInstance> {
        val agentType = providers.first { it.kind == provider }.agentType
        val conventionalDefault = "$agentType-default"
        return instances.withIndex()
            .filter { it.value.enabled && it.value.agentType == agentType }
            .sortedWith(
                compareBy<IndexedValue<ProviderInstance>> { it.value.id != conventionalDefault }
                    .thenBy(String.CASE_INSENSITIVE_ORDER) { it.value.displayName }
                    .thenBy { it.value.createdAt }
                    .thenBy { it.index },
            )
            .map { it.value }
    }

    fun resolveDefaults(
        provider: ProviderKind,
        defaults: SessionDefaults,
        profiles: List<ProviderInstance>,
    ): NewSessionSelection {
        val options = models(provider)
        val defaultModel = defaults.modelId?.takeIf(String::isNotBlank)
        val resolvedOptions = if (defaultModel != null && options.none { it.id == defaultModel }) {
            listOf(
                NewSessionModelOption(
                    id = defaultModel,
                    label = defaultModel,
                    tier = "default",
                    authoritativeDefault = true,
                ),
            ) + options
        } else {
            options.map { it.copy(authoritativeDefault = it.id == defaultModel) }
        }
        val requestedInstance = defaults.instanceId?.takeIf { requested ->
            profiles.any { it.id == requested }
        }
        return NewSessionSelection(
            runtimeMode = RuntimeMode.entries.firstOrNull { it.wire == defaults.runtimeMode }
                ?: RuntimeMode.Sandbox,
            modelId = defaultModel,
            instanceId = requestedInstance ?: profiles.firstOrNull()?.id,
            modelOptions = resolvedOptions,
        )
    }

    private fun model(id: String, label: String, tier: String) =
        NewSessionModelOption(id, label, tier)
}
