package app.switchboard.mobile.platform.update

import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import java.io.File
import java.security.MessageDigest

interface PackageIdentityReader {
    fun installed(): PackageIdentity

    fun archive(apkFile: File): PackageIdentity
}

class AndroidPackageIdentityReader(
    context: Context,
) : PackageIdentityReader {
    private val packageManager = context.applicationContext.packageManager

    override fun installed(): PackageIdentity = packageManager
        .installedPackageInfo(ArchivePreflightPolicy.PRODUCTION_PACKAGE)
        .toIdentity()

    override fun archive(apkFile: File): PackageIdentity = packageManager
        .archivePackageInfo(apkFile.absolutePath)
        .toIdentity()

    @Suppress("DEPRECATION")
    private fun PackageManager.installedPackageInfo(packageName: String): PackageInfo {
        val flags = signingFlags()
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getPackageInfo(packageName, PackageManager.PackageInfoFlags.of(flags.toLong()))
        } else {
            getPackageInfo(packageName, flags)
        }
    }

    @Suppress("DEPRECATION")
    private fun PackageManager.archivePackageInfo(path: String): PackageInfo {
        val flags = signingFlags()
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getPackageArchiveInfo(path, PackageManager.PackageInfoFlags.of(flags.toLong()))
        } else {
            getPackageArchiveInfo(path, flags)
        } ?: error("Android could not inspect the downloaded APK")
    }

    private fun signingFlags(): Int = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        PackageManager.GET_SIGNING_CERTIFICATES
    } else {
        @Suppress("DEPRECATION")
        PackageManager.GET_SIGNATURES
    }

    @Suppress("DEPRECATION")
    private fun PackageInfo.toIdentity(): PackageIdentity {
        val signatures = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            signingInfo?.apkContentsSigners.orEmpty()
        } else {
            signatures.orEmpty()
        }
        return PackageIdentity(
            packageName = packageName.orEmpty(),
            versionCode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) longVersionCode else versionCode.toLong(),
            versionName = versionName.orEmpty(),
            signerSha256 = signatures.mapTo(linkedSetOf()) { signature ->
                MessageDigest.getInstance("SHA-256")
                    .digest(signature.toByteArray())
                    .joinToString(separator = "") { byte -> "%02x".format(byte.toInt() and 0xff) }
            },
        )
    }
}
