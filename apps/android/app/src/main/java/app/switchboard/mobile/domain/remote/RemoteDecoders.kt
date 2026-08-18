package app.switchboard.mobile.domain.remote

import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue

object RemoteDecoders {
    fun projects(value: JsonValue?): List<Project> =
        value.array().values.map { project(it.obj()) }

    fun conversations(value: JsonValue?): List<Conversation> =
        value.array().values.map { conversation(it.obj()) }

    fun workspaces(value: JsonValue?): List<Workspace> =
        value.array().values.map { workspace(it.obj()) }

    fun loadedSession(value: JsonValue?): LoadedSession {
        val raw = value.obj()
        return LoadedSession(
            messages = raw.required("messages").array().values.map { message(it.obj()) },
            meta = when (val meta = raw.values["meta"]) {
                null, JsonNull -> null
                else -> sessionMeta(meta.obj())
            },
            total = raw.long("total"),
            truncated = raw.boolean("truncated"),
            raw = raw,
        )
    }

    fun startedSession(value: JsonValue?): StartedSession {
        val raw = value.obj()
        return StartedSession(
            threadId = raw.stringRequired("threadId"),
            provider = raw.stringRequired("provider"),
            status = raw.stringRequired("status"),
            cwd = raw.stringRequired("cwd"),
            sessionId = raw.string("sessionId"),
            raw = raw,
        )
    }

    fun markRead(value: JsonValue?): MarkReadResult {
        val raw = value.obj()
        return MarkReadResult(
            ok = raw.booleanRequired("ok"),
            at = raw.longRequired("at"),
            raw = raw,
        )
    }

    fun skills(value: JsonValue?): List<ProviderSkill>? {
        if (value == null || value === JsonNull) return null
        return value.array().values.map {
            val raw = it.obj()
            ProviderSkill(
                name = raw.stringRequired("name"),
                description = raw.string("description"),
                argumentHint = raw.string("argumentHint"),
                path = raw.string("path"),
                source = raw.stringRequired("source"),
                raw = raw,
            )
        }
    }

    fun models(value: JsonValue?): List<ModelOption>? {
        if (value == null || value === JsonNull) return null
        return value.array().values.map {
            val raw = it.obj()
            ModelOption(
                id = raw.stringRequired("id"),
                label = raw.stringRequired("label"),
                tier = raw.stringRequired("tier"),
                raw = raw,
            )
        }
    }

    fun setting(value: JsonValue?): String? =
        when (value) {
            null, JsonNull -> null
            is JsonString -> value.value
            else -> error("Expected setting string or null")
        }

    private fun project(raw: JsonObject) = Project(
        path = raw.stringRequired("path"),
        name = raw.stringRequired("name"),
        sessions = raw.required("sessions").array().values.map {
            val session = it.obj()
            SessionSummary(
                id = session.stringRequired("id"),
                source = session.stringRequired("source"),
                title = session.stringRequired("title"),
                startedAt = session.longRequired("startedAt"),
                messageCount = session.longRequired("messageCount"),
                filePath = session.stringRequired("filePath"),
                raw = session,
            )
        },
        workspaceId = raw.string("workspaceId"),
        raw = raw,
    )

    private fun conversation(raw: JsonObject) = Conversation(
        id = raw.stringRequired("id"),
        projectPath = raw.stringRequired("project_path"),
        agentType = raw.stringRequired("agent_type"),
        sessionId = raw.string("session_id"),
        title = raw.stringRequired("title"),
        createdAt = raw.longRequired("created_at"),
        updatedAt = raw.longRequired("updated_at"),
        worktreePath = raw.string("worktree_path"),
        worktreeBranch = raw.string("worktree_branch"),
        raw = raw,
    )

    private fun workspace(raw: JsonObject) = Workspace(
        id = raw.stringRequired("id"),
        name = raw.stringRequired("name"),
        color = raw.string("color"),
        sortOrder = raw.longRequired("sortOrder"),
        createdAt = raw.longRequired("createdAt"),
        raw = raw,
    )

    private fun message(raw: JsonObject) = ChatMessage(
        id = raw.stringRequired("id"),
        role = raw.stringRequired("role"),
        content = raw.stringRequired("content"),
        timestamp = raw.longRequired("timestamp"),
        raw = raw,
    )

    private fun sessionMeta(raw: JsonObject) = SessionMeta(
        id = raw.stringRequired("id"),
        title = raw.stringRequired("title"),
        projectPath = raw.stringRequired("projectPath"),
        agentType = raw.stringRequired("agentType"),
        rootThreadId = raw.string("rootThreadId"),
        raw = raw,
    )

    private fun JsonValue?.obj(): JsonObject =
        this as? JsonObject ?: error("Expected object response")

    private fun JsonValue?.array(): JsonArray =
        this as? JsonArray ?: error("Expected array response")

    private fun JsonObject.required(key: String): JsonValue =
        values[key] ?: error("Missing response field: $key")

    private fun JsonObject.stringRequired(key: String): String =
        (required(key) as? JsonString)?.value ?: error("Expected string field: $key")

    private fun JsonObject.string(key: String): String? =
        when (val value = values[key]) {
            null, JsonNull -> null
            is JsonString -> value.value
            else -> error("Expected nullable string field: $key")
        }

    private fun JsonObject.longRequired(key: String): Long =
        (required(key) as? JsonNumber)?.source?.toLongOrNull()
            ?: error("Expected integer field: $key")

    private fun JsonObject.long(key: String): Long? =
        (values[key] as? JsonNumber)?.source?.toLongOrNull()

    private fun JsonObject.booleanRequired(key: String): Boolean =
        (required(key) as? JsonBoolean)?.value ?: error("Expected boolean field: $key")

    private fun JsonObject.boolean(key: String): Boolean? =
        (values[key] as? JsonBoolean)?.value
}
