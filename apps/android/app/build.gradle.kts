import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.compose.compiler)
    alias(libs.plugins.ksp)
    alias(libs.plugins.androidx.room)
}

val productionKeystorePath = providers.environmentVariable("SWITCHBOARD_ANDROID_KEYSTORE_PATH").orNull

fun requiredSigningEnvironment(name: String): String =
    providers.environmentVariable(name).orNull?.takeIf(String::isNotBlank)
        ?: error("$name is required when SWITCHBOARD_ANDROID_KEYSTORE_PATH is set")

android {
    namespace = "app.switchboard.mobile"
    compileSdk = 36

    defaultConfig {
        applicationId = "app.switchboard.mobile"
        minSdk = 24
        targetSdk = 36
        versionCode = 2
        versionName = "0.5.0"
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
        }
        release {
            signingConfig = productionSigning
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    buildFeatures {
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
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.okhttp)
    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    ksp(libs.androidx.room.compiler)
    debugImplementation(libs.androidx.compose.ui.tooling)

    testImplementation(libs.junit)
    androidTestImplementation(libs.junit)
    androidTestImplementation(libs.androidx.test.core)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.room.testing)
}
