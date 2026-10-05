package app.switchboard.mobile.protocol

/** Strict accessors for test fixtures: a missing or mistyped field fails the test. */
fun JsonValue.requireObject(): JsonObject =
    this as? JsonObject ?: error("Expected JSON object")

fun JsonValue.requireArray(): JsonArray =
    this as? JsonArray ?: error("Expected JSON array")

fun JsonObject.requireValue(key: String): JsonValue =
    values[key] ?: error("Missing JSON field: $key")

fun JsonObject.requireString(key: String): String =
    (requireValue(key) as? JsonString)?.value ?: error("Expected string field: $key")

fun JsonObject.requireBoolean(key: String): Boolean =
    (requireValue(key) as? JsonBoolean)?.value ?: error("Expected boolean field: $key")
