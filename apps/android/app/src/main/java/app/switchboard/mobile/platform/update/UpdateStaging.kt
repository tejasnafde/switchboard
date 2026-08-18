package app.switchboard.mobile.platform.update

import java.io.File

object UpdateStaging {
    fun discard(file: File) {
        check(!file.exists() || file.delete()) { "Could not delete staged update ${file.name}" }
    }
}
