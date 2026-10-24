package app.switchboard.mobile.domain.reviews

import app.switchboard.mobile.protocol.JsonArray
import app.switchboard.mobile.protocol.JsonBoolean
import app.switchboard.mobile.protocol.JsonNull
import app.switchboard.mobile.protocol.JsonNumber
import app.switchboard.mobile.protocol.JsonObject
import app.switchboard.mobile.protocol.JsonString
import app.switchboard.mobile.protocol.JsonValue

/**
 * Decoders for the `pull-requests:*` responses a phone reads. Required fields
 * fail the decode (the client reports a malformed response); fields an older
 * backend leaves out read as their default.
 */
object PullRequestDecoders {
    /** `pull-requests:list` and `pull-requests:detail` answer `{ ok: true, data } | { ok: false, error }`. */
    fun <T> result(value: JsonValue?, data: (JsonValue) -> T): PrResult<T> {
        val raw = value.obj()
        return if (raw.booleanRequired("ok")) {
            PrResult.Ok(data(raw.required("data")))
        } else {
            PrResult.Failed(error(raw.required("error").obj()))
        }
    }

    fun listResult(value: JsonValue?): PrResult<PrListData> = result(value, ::listData)

    fun detailResult(value: JsonValue?): PrResult<PrDetail> = result(value, ::detail)

    fun listData(value: JsonValue?): PrListData {
        val raw = value.obj()
        return PrListData(
            prs = raw.optionalArray("prs").map { summary(it) },
            sources = raw.optionalArray("sources").map { source(it.obj()) },
            fetchedAt = raw.long("fetchedAt") ?: 0,
            hidden = raw.optionalArray("hidden").map { it.string("hidden key") },
            hiddenRepos = raw.optionalArray("hiddenRepos").map { repo(it.obj()) },
        )
    }

    fun summary(value: JsonValue?): PrSummary {
        val raw = value.obj()
        val checks = raw.required("checks").obj()
        val approvals = raw.required("approvals").obj()
        val viewer = raw.required("viewer").obj()
        return PrSummary(
            ref = ref(raw.required("ref").obj()),
            title = raw.stringRequired("title"),
            url = raw.stringRequired("url"),
            author = person(raw.required("author").obj()),
            state = raw.stringRequired("state"),
            draft = raw.boolean("draft") ?: false,
            sourceBranch = raw.stringRequired("sourceBranch"),
            targetBranch = raw.stringRequired("targetBranch"),
            headFromFork = raw.boolean("headFromFork") ?: false,
            createdAt = raw.long("createdAt") ?: 0,
            updatedAt = raw.longRequired("updatedAt"),
            mergedAt = raw.long("mergedAt"),
            additions = raw.long("additions"),
            deletions = raw.long("deletions"),
            changedFiles = raw.long("changedFiles"),
            unresolvedConversations = raw.long("unresolvedConversations")?.toInt(),
            mergeConflicts = raw.boolean("mergeConflicts"),
            conflictedFiles = raw.optionalArray("conflictedFiles").map { it.string("conflicted file") },
            checks = ChecksRollup(
                state = checks.stringRequired("state"),
                total = checks.int("total"),
                passed = checks.int("passed"),
                failed = checks.int("failed"),
                pending = checks.int("pending"),
            ),
            reviewers = raw.optionalArray("reviewers").map { reviewer ->
                val r = reviewer.obj()
                PrReviewer(
                    id = r.string("id"),
                    person = person(r.required("person").obj()),
                    state = r.stringRequired("state"),
                    requested = r.boolean("requested") ?: false,
                )
            },
            approvals = PrApprovals(
                given = approvals.int("given"),
                required = approvals.long("required")?.toInt(),
            ),
            viewer = PrViewer(
                isAuthor = viewer.boolean("isAuthor") ?: false,
                isRequestedReviewer = viewer.boolean("isRequestedReviewer") ?: false,
                hasReviewed = viewer.boolean("hasReviewed") ?: false,
                hasCommented = viewer.boolean("hasCommented") ?: false,
            ),
            projectPaths = raw.optionalArray("projectPaths").map { it.string("project path") },
        )
    }

    fun detail(value: JsonValue?): PrDetail {
        val raw = value.obj()
        return PrDetail(
            summary = summary(raw),
            description = raw.string("description").orEmpty(),
            checkList = raw.optionalArray("checkList").map { check(it.obj()) },
        )
    }

    fun check(raw: JsonObject): PrCheck = PrCheck(
        id = raw.stringRequired("id"),
        name = raw.stringRequired("name"),
        state = raw.stringRequired("state"),
        description = raw.string("description"),
        url = raw.string("url"),
        durationMs = raw.long("durationMs"),
    )

    fun source(raw: JsonObject): PrSource = PrSource(
        repo = repo(raw.required("repo").obj()),
        projectPaths = raw.optionalArray("projectPaths").map { it.string("project path") },
        error = (raw.values["error"] as? JsonObject)?.let(::error),
    )

    fun error(raw: JsonObject): PrError = PrError(
        kind = raw.string("kind") ?: "unknown",
        host = raw.string("host"),
        message = raw.string("message") ?: "Could not read pull requests",
    )

    /** `pull-requests:conversations`. */
    fun conversationsResult(value: JsonValue?): PrResult<List<PrConversation>> =
        result(value) { data -> data.array().values.map { conversation(it.obj()) } }

    fun conversation(raw: JsonObject): PrConversation = PrConversation(
        id = raw.stringRequired("id"),
        path = raw.string("path"),
        line = raw.long("line"),
        startLine = raw.long("startLine"),
        resolved = raw.boolean("resolved") ?: false,
        outdated = raw.boolean("outdated") ?: false,
        comments = raw.optionalArray("comments").map {
            val comment = it.obj()
            PrComment(
                id = comment.stringRequired("id"),
                author = person(comment.required("author").obj()),
                body = comment.string("body").orEmpty(),
                createdAt = comment.long("createdAt") ?: 0,
            )
        },
    )

    /** `pull-requests:write-account`: `{ account }`. */
    fun writeAccountResult(value: JsonValue?): PrResult<String> =
        result(value) { data -> data.obj().stringRequired("account") }

    /** A phone write's answer: `{ refresh: string[] }`. */
    fun writeResult(value: JsonValue?): PrResult<List<String>> =
        result(value) { data -> data.obj().optionalArray("refresh").map { it.string("refresh key") } }

    /** `device-session:scopes`: the caller's current scopes. */
    fun scopes(value: JsonValue?): List<String> = value.array().values.map { it.string("scope") }

    /** `pull-requests:linked-chats` and `pull-requests:linkable-chats`. */
    fun linkChats(value: JsonValue?): List<PrLinkChat> {
        if (value == null || value === JsonNull) return emptyList()
        return value.array().values.map {
            val raw = it.obj()
            PrLinkChat(
                id = raw.stringRequired("id"),
                familyIds = raw.optionalArray("familyIds").map { id -> id.string("family id") },
                title = raw.stringRequired("title"),
                agentType = raw.stringRequired("agentType"),
                projectPath = raw.stringRequired("projectPath"),
                updatedAt = raw.long("updatedAt") ?: 0,
                linkSource = raw.string("linkSource"),
            )
        }
    }

    /** `{ ok: true }` or `{ ok: false, message }`. */
    fun actionResult(value: JsonValue?): PrActionResult {
        val raw = value.obj()
        return PrActionResult(ok = raw.booleanRequired("ok"), message = raw.string("message"))
    }

    fun ref(raw: JsonObject): PrRef = PrRef(
        host = raw.stringRequired("host"),
        owner = raw.stringRequired("owner"),
        name = raw.stringRequired("name"),
        number = raw.longRequired("number"),
    )

    fun repo(raw: JsonObject): RepoRef = RepoRef(
        host = raw.stringRequired("host"),
        owner = raw.stringRequired("owner"),
        name = raw.stringRequired("name"),
    )

    private fun person(raw: JsonObject): PrPerson = PrPerson(
        login = raw.string("login").orEmpty(),
        displayName = raw.string("displayName") ?: raw.string("login").orEmpty(),
        avatarUrl = raw.string("avatarUrl"),
    )

    private fun JsonValue?.obj(): JsonObject = this as? JsonObject ?: error("Expected object response")

    private fun JsonValue?.array(): JsonArray = this as? JsonArray ?: error("Expected array response")

    private fun JsonValue.string(what: String): String = (this as? JsonString)?.value ?: error("Expected $what string")

    private fun JsonObject.required(key: String): JsonValue = values[key] ?: error("Missing response field: $key")

    private fun JsonObject.stringRequired(key: String): String =
        (required(key) as? JsonString)?.value ?: error("Expected string field: $key")

    private fun JsonObject.string(key: String): String? = (values[key] as? JsonString)?.value

    private fun JsonObject.long(key: String): Long? = (values[key] as? JsonNumber)?.source?.let { source ->
        source.toLongOrNull() ?: source.toDoubleOrNull()?.toLong()
    }

    private fun JsonObject.longRequired(key: String): Long = long(key) ?: error("Expected integer field: $key")

    private fun JsonObject.int(key: String): Int = long(key)?.toInt() ?: 0

    private fun JsonObject.boolean(key: String): Boolean? = (values[key] as? JsonBoolean)?.value

    private fun JsonObject.booleanRequired(key: String): Boolean = boolean(key) ?: error("Expected boolean field: $key")

    private fun JsonObject.optionalArray(key: String): List<JsonValue> = (values[key] as? JsonArray)?.values.orEmpty()
}
