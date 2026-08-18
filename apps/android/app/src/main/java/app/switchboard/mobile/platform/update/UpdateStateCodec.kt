package app.switchboard.mobile.platform.update

import app.switchboard.mobile.update.DownloadedApk
import app.switchboard.mobile.update.UpdateRelease
import app.switchboard.mobile.update.UpdateStage
import app.switchboard.mobile.update.UpdateState
import app.switchboard.mobile.update.VerifiedApk

object UpdateStateCodec {
    fun encode(state: UpdateState): Map<String, String> = buildMap {
        put("type", state.type)
        when (state) {
            UpdateState.Idle,
            UpdateState.Checking,
            UpdateState.UpToDate,
            -> Unit

            is UpdateState.Available -> putRelease("release", state.release)
            is UpdateState.Downloading -> {
                putRelease("release", state.release)
                put("bytesDownloaded", state.bytesDownloaded.toString())
                state.totalBytes?.let { put("totalBytes", it.toString()) }
            }

            is UpdateState.Cancelling -> {
                putRelease("release", state.release)
                put("bytesDownloaded", state.bytesDownloaded.toString())
                state.totalBytes?.let { put("totalBytes", it.toString()) }
            }

            is UpdateState.Verifying -> putDownloaded("downloaded", state.downloadedApk)
            is UpdateState.InstallerReady -> putVerified("verified", state.artifact)
            is UpdateState.CheckingInstallPermission -> putVerified("verified", state.artifact)
            is UpdateState.PermissionRequired -> {
                putRelease("release", state.release)
                putVerified("verified", state.artifact)
            }

            is UpdateState.LaunchRequested -> putVerified("verified", state.artifact)
            is UpdateState.Error -> {
                put("stage", state.stage.name)
                put("message", state.message)
                state.release?.let { putRelease("release", it) }
                state.downloadedApk?.let { putDownloaded("downloaded", it) }
                state.verifiedApk?.let { putVerified("verified", it) }
            }
        }
    }

    fun decode(values: Map<String, String>): UpdateState? = try {
        when (values.required("type")) {
            "idle" -> UpdateState.Idle
            "checking" -> UpdateState.Checking
            "up_to_date" -> UpdateState.UpToDate
            "available" -> UpdateState.Available(values.release("release"))
            "downloading" -> UpdateState.Downloading(
                release = values.release("release"),
                bytesDownloaded = values.required("bytesDownloaded").toLong(),
                totalBytes = values["totalBytes"]?.toLong(),
            )

            "cancelling" -> UpdateState.Cancelling(
                release = values.release("release"),
                bytesDownloaded = values.required("bytesDownloaded").toLong(),
                totalBytes = values["totalBytes"]?.toLong(),
            )

            "verifying" -> UpdateState.Verifying(values.downloaded("downloaded"))
            "installer_ready" -> UpdateState.InstallerReady(values.verified("verified"))
            "checking_install_permission" -> UpdateState.CheckingInstallPermission(values.verified("verified"))
            "permission_required" -> UpdateState.PermissionRequired(
                release = values.release("release"),
                artifact = values.verified("verified"),
            )

            "launch_requested" -> UpdateState.LaunchRequested(values.verified("verified"))
            "error" -> UpdateState.Error(
                stage = UpdateStage.valueOf(values.required("stage")),
                message = values.required("message"),
                release = values.releaseOrNull("release"),
                downloadedApk = values.downloadedOrNull("downloaded"),
                verifiedApk = values.verifiedOrNull("verified"),
            )

            else -> null
        }
    } catch (_: RuntimeException) {
        null
    }

    private val UpdateState.type: String
        get() = when (this) {
            UpdateState.Idle -> "idle"
            UpdateState.Checking -> "checking"
            UpdateState.UpToDate -> "up_to_date"
            is UpdateState.Available -> "available"
            is UpdateState.Downloading -> "downloading"
            is UpdateState.Cancelling -> "cancelling"
            is UpdateState.Verifying -> "verifying"
            is UpdateState.InstallerReady -> "installer_ready"
            is UpdateState.CheckingInstallPermission -> "checking_install_permission"
            is UpdateState.PermissionRequired -> "permission_required"
            is UpdateState.LaunchRequested -> "launch_requested"
            is UpdateState.Error -> "error"
        }

    private fun MutableMap<String, String>.putRelease(prefix: String, release: UpdateRelease) {
        put("$prefix.version", release.version)
        put("$prefix.apkUrl", release.apkUrl)
        release.expectedSha256?.let { put("$prefix.expectedSha256", it) }
    }

    private fun MutableMap<String, String>.putDownloaded(prefix: String, downloadedApk: DownloadedApk) {
        putRelease("$prefix.release", downloadedApk.release)
        put("$prefix.filePath", downloadedApk.filePath)
    }

    private fun MutableMap<String, String>.putVerified(prefix: String, verifiedApk: VerifiedApk) {
        putRelease("$prefix.release", verifiedApk.release)
        put("$prefix.filePath", verifiedApk.filePath)
        put("$prefix.contentUri", verifiedApk.contentUri)
    }

    private fun Map<String, String>.release(prefix: String) = UpdateRelease(
        version = required("$prefix.version"),
        apkUrl = required("$prefix.apkUrl"),
        expectedSha256 = this["$prefix.expectedSha256"],
    )

    private fun Map<String, String>.releaseOrNull(prefix: String): UpdateRelease? =
        if (containsKey("$prefix.version")) release(prefix) else null

    private fun Map<String, String>.downloaded(prefix: String) = DownloadedApk(
        release = release("$prefix.release"),
        filePath = required("$prefix.filePath"),
    )

    private fun Map<String, String>.downloadedOrNull(prefix: String): DownloadedApk? =
        if (containsKey("$prefix.filePath")) downloaded(prefix) else null

    private fun Map<String, String>.verified(prefix: String) = VerifiedApk(
        release = release("$prefix.release"),
        filePath = required("$prefix.filePath"),
        contentUri = required("$prefix.contentUri"),
    )

    private fun Map<String, String>.verifiedOrNull(prefix: String): VerifiedApk? =
        if (containsKey("$prefix.filePath")) verified(prefix) else null

    private fun Map<String, String>.required(key: String): String =
        get(key)?.takeIf(String::isNotEmpty) ?: error("Missing persisted update field: $key")
}
