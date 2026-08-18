package app.switchboard.mobile.platform.update

import android.content.Context
import android.system.Os
import androidx.core.content.FileProvider
import app.switchboard.mobile.update.DownloadedApk
import app.switchboard.mobile.update.UpdateVerifier
import app.switchboard.mobile.update.VerifiedApk
import java.io.File
import java.security.MessageDigest

class UpdateVerificationRejectedException(message: String) : SecurityException(message)

class AndroidUpdateVerifier(
    context: Context,
    private val packageIdentityReader: PackageIdentityReader = AndroidPackageIdentityReader(context),
) : UpdateVerifier {
    private val applicationContext = context.applicationContext
    private val updatesDirectory = File(applicationContext.cacheDir, UPDATES_DIRECTORY).canonicalFile

    override suspend fun verify(downloadedApk: DownloadedApk): VerifiedApk {
        val persistedFile = File(downloadedApk.filePath).canonicalFile
        val finalFile = persistedFile.finalApkFile().canonicalFile
        require(finalFile.parentFile == updatesDirectory) { "Downloaded update escaped the update cache" }
        require(finalFile.name.endsWith(APK_SUFFIX)) { "Downloaded update did not target an APK" }

        val sourceFile = when {
            persistedFile.isFile -> persistedFile
            finalFile.isFile -> finalFile
            else -> error("Downloaded update file is missing")
        }

        try {
            verifyDigest(downloadedApk, sourceFile)
            val installed = packageIdentityReader.installed()
            val archive = packageIdentityReader.archive(sourceFile)
            when (val decision = ArchivePreflightPolicy.evaluate(downloadedApk.release, installed, archive)) {
                ArchivePreflightDecision.Accept -> Unit
                is ArchivePreflightDecision.Reject -> throw UpdateVerificationRejectedException(
                    decision.reason.message,
                )
            }

            if (sourceFile != finalFile) {
                Os.rename(sourceFile.absolutePath, finalFile.absolutePath)
            }
            val contentUri = FileProvider.getUriForFile(
                applicationContext,
                "${applicationContext.packageName}.files",
                finalFile,
            )
            return VerifiedApk(
                release = downloadedApk.release,
                filePath = finalFile.absolutePath,
                contentUri = contentUri.toString(),
            )
        } catch (failure: Throwable) {
            UpdateStaging.discard(sourceFile)
            throw failure
        }
    }

    private fun verifyDigest(downloadedApk: DownloadedApk, file: File) {
        val expected = downloadedApk.release.expectedSha256
            ?.takeIf { SHA_256_PATTERN.matches(it) }
            ?: throw UpdateVerificationRejectedException("Release did not provide a valid SHA-256 digest")
        val actual = UpdateDigest.sha256(file)
        if (!MessageDigest.isEqual(expected.lowercase().toByteArray(), actual.toByteArray())) {
            throw UpdateVerificationRejectedException("Downloaded APK SHA-256 did not match the release")
        }
    }

    private fun File.finalApkFile(): File = if (name.endsWith(PART_SUFFIX)) {
        File(parentFile, name.removeSuffix(PART_SUFFIX))
    } else {
        this
    }

    private val ArchiveRejection.message: String
        get() = when (this) {
            ArchiveRejection.PACKAGE_NAME -> "Downloaded APK has the wrong package ID"
            ArchiveRejection.SIGNER -> "Downloaded APK signer does not match the installed app"
            ArchiveRejection.VERSION_CODE -> "Downloaded APK version code is not newer"
            ArchiveRejection.VERSION_NAME -> "Downloaded APK version name does not match the release"
        }

    private companion object {
        const val UPDATES_DIRECTORY = "updates"
        const val PART_SUFFIX = ".part"
        const val APK_SUFFIX = ".apk"
        val SHA_256_PATTERN = Regex("[0-9a-fA-F]{64}")
    }
}
