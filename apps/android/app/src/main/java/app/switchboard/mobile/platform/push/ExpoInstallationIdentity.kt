package app.switchboard.mobile.platform.push

import java.io.File
import java.io.FileOutputStream
import java.util.UUID

class ExpoInstallationIdentity(
    private val noBackupDirectory: File,
    private val legacyPreference: () -> String?,
    private val newUuid: () -> String = { UUID.randomUUID().toString() },
) {
    private var cached: String? = null

    @Synchronized
    fun getOrCreate(): String {
        cached?.let { return it }
        val primary = noBackupDirectory.resolve(PRIMARY_FILE_NAME)
        val selected = readUuid(primary)
            ?: normalize(legacyPreference())
            ?: readUuid(noBackupDirectory.resolve(LEGACY_FILE_NAME))
            ?: normalize(newUuid())
            ?: error("UUID source returned an invalid installation id")
        persist(primary, selected)
        cached = selected
        return selected
    }

    private fun readUuid(file: File): String? = runCatching {
        if (!file.isFile) null else normalize(file.bufferedReader().use { it.readLine() })
    }.getOrNull()

    private fun persist(file: File, value: String) {
        noBackupDirectory.mkdirs()
        val temporary = noBackupDirectory.resolve("$PRIMARY_FILE_NAME.tmp")
        runCatching {
            FileOutputStream(temporary).use { output ->
                output.write(value.toByteArray(Charsets.UTF_8))
                output.fd.sync()
            }
            if (!temporary.renameTo(file)) {
                FileOutputStream(file).use { output ->
                    output.write(value.toByteArray(Charsets.UTF_8))
                    output.fd.sync()
                }
                temporary.delete()
            }
        }
    }

    private fun normalize(value: String?): String? = runCatching {
        UUID.fromString(value?.trim()).toString()
    }.getOrNull()

    companion object {
        const val PRIMARY_FILE_NAME = "expo_notifications_installation_uuid.txt"
        const val LEGACY_FILE_NAME = "expo_installation_uuid.txt"
        const val LEGACY_PREFERENCES_NAME = "host.exp.exponent.SharedPreferences"
        const val LEGACY_PREFERENCE_KEY = "uuid"
    }
}
