package app.switchboard.mobile.platform.update

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import app.switchboard.mobile.update.UpdateInstaller
import app.switchboard.mobile.update.VerifiedApk
import java.io.File

class AndroidUpdateInstaller(
    context: Context,
    private val packageIdentityReader: PackageIdentityReader = AndroidPackageIdentityReader(context),
    private val pendingInstallationPersistence: PendingInstallationPersistence =
        SharedPreferencesPendingInstallationPersistence(context),
    private val clockMillis: () -> Long = System::currentTimeMillis,
) : UpdateInstaller {
    private val applicationContext = context.applicationContext

    override fun canRequestPackageInstalls(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.O || applicationContext.packageManager.canRequestPackageInstalls()

    override fun openUnknownSourcesSettings() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        applicationContext.startActivity(
            Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:${applicationContext.packageName}"),
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }

    override fun launchInstaller(artifact: VerifiedApk) {
        check(canRequestPackageInstalls()) { "Switchboard is not allowed to request package installation" }
        val installed = packageIdentityReader.installed()
        val archive = packageIdentityReader.archive(File(artifact.filePath))
        check(ArchivePreflightPolicy.evaluate(artifact.release, installed, archive) == ArchivePreflightDecision.Accept) {
            "APK identity changed after verification"
        }

        val pending = PendingInstallation(
            packageName = archive.packageName,
            baselineVersionCode = installed.versionCode,
            targetVersionCode = archive.versionCode,
            targetVersionName = archive.versionName,
            signerSha256 = archive.signerSha256,
            requestedAtEpochMillis = clockMillis(),
        )
        pendingInstallationPersistence.save(pending)

        val contentUri = Uri.parse(artifact.contentUri)
        require(contentUri.scheme == "content") { "Installer requires a content URI" }
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(contentUri, APK_MIME_TYPE)
            clipData = ClipData.newRawUri("Switchboard update", contentUri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try {
            applicationContext.startActivity(intent)
        } catch (failure: Throwable) {
            runCatching { pendingInstallationPersistence.clear() }
            throw failure
        }
    }

    private companion object {
        const val APK_MIME_TYPE = "application/vnd.android.package-archive"
    }
}
