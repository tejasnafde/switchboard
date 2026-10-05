package app.switchboard.mobile.compat

data class LegacyStorageLayout(val database: String, val table: String)

data class LegacyStorageDump(
    val layout: LegacyStorageLayout,
    val rows: LinkedHashMap<String, String>,
)

/** Test fixture: decodes an AsyncStorage dump the way the React Native app laid it out. */
object LegacyAsyncStorageDecoder {
    private val supportedLayouts = setOf(
        LegacyStorageLayout("RKStorage", "catalystLocalStorage"),
        LegacyStorageLayout("AsyncStorage", "Storage"),
    )

    fun decode(source: String): LegacyStorageDump {
        val root = LegacyJsonParser.parse(source).objectOrNull()
            ?: throw LegacyJsonException("AsyncStorage dump must be an object")
        val database = root.requiredString("database")
        val table = root.requiredString("table")
        val layout = LegacyStorageLayout(database, table)
        if (layout !in supportedLayouts) {
            throw LegacyJsonException("unsupported AsyncStorage layout $database/$table")
        }
        val columns = root.values["columns"]?.arrayOrNull()?.values?.mapNotNull { it.stringOrNull() }
        if (columns != listOf("key", "value")) {
            throw LegacyJsonException("AsyncStorage columns must be key,value")
        }
        val encodedRows = root.values["rows"]?.arrayOrNull()?.values
            ?: throw LegacyJsonException("AsyncStorage rows must be an array")
        val rows = linkedMapOf<String, String>()
        for ((index, encoded) in encodedRows.withIndex()) {
            val row = encoded.objectOrNull() ?: throw LegacyJsonException("row $index must be an object")
            val key = row.requiredString("key")
            val value = row.requiredString("value")
            if (rows.put(key, value) != null) throw LegacyJsonException("duplicate AsyncStorage key $key")
        }
        return LegacyStorageDump(layout, rows)
    }
}
