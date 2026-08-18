package app.switchboard.mobile.platform.migration

data class LegacyDatabaseLayout(
    val database: String,
    val table: String,
)

data class LegacyDatabaseQuery(
    val layout: LegacyDatabaseLayout,
    val exactKeys: Set<String>,
    val likePattern: String,
)

sealed interface LegacyDatabaseRead {
    data class Rows(val values: Map<String, String>) : LegacyDatabaseRead
    data object Missing : LegacyDatabaseRead
    data class Failure(
        val kind: LegacyInventoryFailure.Kind,
        val detail: String,
    ) : LegacyDatabaseRead
}

fun interface LegacyDatabaseReader {
    fun read(query: LegacyDatabaseQuery): LegacyDatabaseRead
}

data class LegacyInventoryFailure(
    val kind: Kind,
    val detail: String,
    val layout: LegacyDatabaseLayout? = null,
) {
    enum class Kind { OPEN, SCHEMA, WAL, READ, CONFLICT }
}

sealed interface LegacyInventoryResult {
    data class Success(val rows: LinkedHashMap<String, String>) : LegacyInventoryResult
    data class Failed(
        val failures: List<LegacyInventoryFailure>,
        val partialRows: LinkedHashMap<String, String>,
    ) : LegacyInventoryResult
}

fun interface LegacyInventorySource {
    fun read(): LegacyInventoryResult
}

class LegacyInventory(
    private val reader: LegacyDatabaseReader,
) : LegacyInventorySource {
    override fun read(): LegacyInventoryResult {
        val rows = linkedMapOf<String, String>()
        val failures = mutableListOf<LegacyInventoryFailure>()

        for (layout in LAYOUTS) {
            when (val result = reader.read(LegacyDatabaseQuery(layout, EXACT_KEYS, OUTBOX_PATTERN))) {
                LegacyDatabaseRead.Missing -> Unit
                is LegacyDatabaseRead.Failure -> failures += LegacyInventoryFailure(
                    kind = result.kind,
                    detail = result.detail,
                    layout = layout,
                )
                is LegacyDatabaseRead.Rows -> mergeRows(rows, result.values, layout, failures)
            }
        }

        return if (failures.isEmpty()) {
            LegacyInventoryResult.Success(rows)
        } else {
            LegacyInventoryResult.Failed(failures, rows)
        }
    }

    private fun mergeRows(
        destination: LinkedHashMap<String, String>,
        incoming: Map<String, String>,
        layout: LegacyDatabaseLayout,
        failures: MutableList<LegacyInventoryFailure>,
    ) {
        for ((key, value) in incoming) {
            val prior = destination[key]
            if (prior == null) {
                destination[key] = value
            } else if (prior != value) {
                failures += LegacyInventoryFailure(
                    kind = LegacyInventoryFailure.Kind.CONFLICT,
                    detail = "legacy databases contain different values for $key",
                    layout = layout,
                )
            }
        }
    }

    private companion object {
        val LAYOUTS = listOf(
            LegacyDatabaseLayout("RKStorage", "catalystLocalStorage"),
            LegacyDatabaseLayout("AsyncStorage", "Storage"),
        )
        val EXACT_KEYS = setOf("sb-connections", "switchboard-prefs", "sb-chat-cache")
        const val OUTBOX_PATTERN = "sb-outbox:%"
    }
}
