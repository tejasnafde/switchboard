import groovy.json.JsonSlurper
import org.gradle.api.tasks.testing.logging.TestExceptionFormat
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.compose.compiler)
    alias(libs.plugins.ksp)
    alias(libs.plugins.androidx.room)
}

val productionKeystorePath = providers.environmentVariable("SWITCHBOARD_ANDROID_KEYSTORE_PATH").orNull
val canonicalApplicationId = "app.tn07.switchboard"
val easProjectId = "efbb89d9-210f-4584-bf62-8186cd5fb476"
val googleServicesFile = file("google-services.json")
val googleServices = JsonSlurper().parse(googleServicesFile) as Map<*, *>
val firebaseProject = googleServices["project_info"] as Map<*, *>
val firebaseClient = (googleServices["client"] as List<*>)
    .map { it as Map<*, *> }
    .single { client ->
        val clientInfo = client["client_info"] as Map<*, *>
        val androidInfo = clientInfo["android_client_info"] as Map<*, *>
        androidInfo["package_name"] == canonicalApplicationId
    }
val firebaseClientInfo = firebaseClient["client_info"] as Map<*, *>
val firebaseApiKey = ((firebaseClient["api_key"] as List<*>).single() as Map<*, *>)["current_key"] as String

fun requiredSigningEnvironment(name: String): String =
    providers.environmentVariable(name).orNull?.takeIf(String::isNotBlank)
        ?: error("$name is required when SWITCHBOARD_ANDROID_KEYSTORE_PATH is set")

android {
    namespace = "app.switchboard.mobile"
    compileSdk = 36
    ndkVersion = "27.0.12077973"

    defaultConfig {
        applicationId = canonicalApplicationId
        minSdk = 24
        targetSdk = 36
        versionCode = 24
        versionName = "0.5.22"
        buildConfigField("String", "EXPO_PROJECT_ID", "\"$easProjectId\"")
        buildConfigField("String", "PUSH_APPLICATION_ID", "\"$canonicalApplicationId\"")
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    val productionSigning = productionKeystorePath?.let { path ->
        signingConfigs.create("production") {
            storeFile = file(path)
            storePassword = requiredSigningEnvironment("SWITCHBOARD_ANDROID_KEYSTORE_PASSWORD")
            keyAlias = requiredSigningEnvironment("SWITCHBOARD_ANDROID_KEY_ALIAS")
            keyPassword = requiredSigningEnvironment("SWITCHBOARD_ANDROID_KEY_PASSWORD")
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".native.dev"
            versionNameSuffix = "-native-dev"
            buildConfigField("boolean", "REMOTE_PUSH_ENABLED", "false")
        }
        release {
            buildConfigField("boolean", "REMOTE_PUSH_ENABLED", "true")
            resValue("string", "google_app_id", firebaseClientInfo["mobilesdk_app_id"] as String)
            resValue("string", "gcm_defaultSenderId", firebaseProject["project_number"] as String)
            resValue("string", "google_api_key", firebaseApiKey)
            resValue("string", "project_id", firebaseProject["project_id"] as String)
            resValue("string", "google_storage_bucket", firebaseProject["storage_bucket"] as String)
            signingConfig = productionSigning
            // Symbol tables of the bundled native libraries (ML Kit, CameraX) go
            // into the AAB's BUNDLE-METADATA, where Play reads them for crash reports.
            ndk.debugSymbolLevel = "SYMBOL_TABLE"
            // With R8 off there is no mapping.txt; mobile-release.yml uploads one
            // when R8 is turned on.
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    buildFeatures {
        buildConfig = true
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        unitTests.isIncludeAndroidResources = true
    }

    // The chat visual host page (scripts/build-visual-host.mjs) is one file
    // shared with the Expo app, so the assets come from its folder.
    sourceSets["main"].assets.srcDir("../../mobile/assets/visual-host")
    // The demo fixture is one file shared with the Expo app and the TS player
    // (src/shared/phone-demo/phone-demo.ts), so it ships from its own folder.
    sourceSets["main"].assets.srcDir("../../../src/shared/phone-demo/fixture")

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
}

// CI shows only the console, so a failed test prints its whole stack trace
// there. The short form named only Preconditions.kt:26 for a Compose
// precondition and hid which one failed.
tasks.withType<Test>().configureEach {
    testLogging {
        events("failed")
        exceptionFormat = TestExceptionFormat.FULL
    }
}

tasks.register("printReleaseVersionName") {
    doLast { println(android.defaultConfig.versionName ?: error("release versionName is missing")) }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_17
    }
}

room {
    schemaDirectory("$rootDir/schemas")
}

dependencies {
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.biometric)
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.fragment)

    val composeBom = platform(libs.androidx.compose.bom)
    implementation(composeBom)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.core)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.okhttp)
    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    implementation(libs.androidx.exifinterface)
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)
    implementation(libs.mlkit.barcode.scanning)
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)
    ksp(libs.androidx.room.compiler)
    debugImplementation(libs.androidx.compose.ui.tooling)
    debugImplementation(libs.androidx.compose.ui.test.manifest)

    testImplementation(libs.junit)
    testImplementation(libs.mockwebserver)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(composeBom)
    testImplementation(libs.androidx.compose.ui.test.junit4)
    androidTestImplementation(libs.junit)
    androidTestImplementation(libs.androidx.test.core)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(composeBom)
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    androidTestImplementation(libs.androidx.room.testing)
}
