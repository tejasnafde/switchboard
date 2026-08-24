import groovy.json.JsonSlurper
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.compose.compiler)
    alias(libs.plugins.ksp)
    alias(libs.plugins.androidx.room)
}

val productionKeystorePath = providers.environmentVariable("SWITCHBOARD_ANDROID_KEYSTORE_PATH").orNull
val canonicalApplicationId = "app.switchboard.mobile"
val easProjectId = "efbb89d9-210f-4584-bf62-8186cd5fb476"
val mobileGoogleServicesFile = rootProject.file("../mobile/google-services.json")
val mobileGoogleServices = JsonSlurper().parse(mobileGoogleServicesFile) as Map<*, *>
val firebaseProject = mobileGoogleServices["project_info"] as Map<*, *>
val firebaseClient = (mobileGoogleServices["client"] as List<*>)
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

    defaultConfig {
        applicationId = canonicalApplicationId
        minSdk = 24
        targetSdk = 36
        versionCode = 10
        versionName = "0.5.8"
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

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
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

    val composeBom = platform(libs.androidx.compose.bom)
    implementation(composeBom)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.core)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.okhttp)
    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
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
    androidTestImplementation(libs.junit)
    androidTestImplementation(libs.androidx.test.core)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(composeBom)
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    androidTestImplementation(libs.androidx.room.testing)
}
