#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
mobile="$(cd "$root/../mobile" && pwd)"

require_file() {
  test -f "$root/$1" || {
    echo "missing $1" >&2
    return 1
  }
}

require_text() {
  local file="$1"
  local text="$2"
  grep -Fq "$text" "$root/$file" || {
    echo "$file does not contain: $text" >&2
    return 1
  }
}

require_file gradlew
require_file gradle/wrapper/gradle-wrapper.jar
require_file gradle/wrapper/gradle-wrapper.properties
require_file gradle/libs.versions.toml
require_file settings.gradle.kts
require_file build.gradle.kts
require_file app/build.gradle.kts
require_file app/src/main/AndroidManifest.xml
require_file app/src/main/java/app/switchboard/mobile/AppContract.kt
require_file app/src/main/java/app/switchboard/mobile/MainActivity.kt
require_file app/src/main/java/app/switchboard/mobile/ui/SwitchboardApp.kt

require_text app/build.gradle.kts 'namespace = "app.switchboard.mobile"'
require_text app/build.gradle.kts 'val canonicalApplicationId = "app.switchboard.mobile"'
require_text app/build.gradle.kts 'applicationId = canonicalApplicationId'
require_text app/build.gradle.kts 'applicationIdSuffix = ".native.dev"'
require_text app/build.gradle.kts 'compileSdk = 36'
require_text app/build.gradle.kts 'minSdk = 24'
require_text app/build.gradle.kts 'targetSdk = 36'
require_text app/build.gradle.kts 'versionCode = 2'
require_text app/build.gradle.kts 'versionName = "0.5.0"'
require_text app/build.gradle.kts 'JavaVersion.VERSION_17'
require_text app/build.gradle.kts 'jvmTarget = JvmTarget.JVM_17'

manifest=app/src/main/AndroidManifest.xml
for permission in INTERNET ACCESS_NETWORK_STATE CAMERA RECORD_AUDIO POST_NOTIFICATIONS REQUEST_INSTALL_PACKAGES; do
  require_text "$manifest" "android.permission.$permission"
done
require_text "$manifest" 'android:usesCleartextTraffic="true"'
require_text "$manifest" 'android:screenOrientation="portrait"'
require_text "$manifest" 'androidx.core.content.FileProvider'
require_text "$manifest" 'android:scheme="switchboard"'
require_text "$manifest" 'android:scheme="com.googleusercontent.apps.974343814740-be31f3e59stdql81uke54r62aodb5c7q"'

require_text app/src/main/java/app/switchboard/mobile/AppContract.kt 'NOTIFICATION_CHANNEL_ID = "switchboard-agents"'
require_text app/src/main/java/app/switchboard/mobile/MainActivity.kt 'enableEdgeToEdge'
require_text app/src/main/java/app/switchboard/mobile/ui/SwitchboardApp.kt 'Switchboard'

require_file app/src/main/res/drawable-nodpi/switchboard_icon.png
require_file app/src/main/res/drawable-nodpi/switchboard_adaptive_icon.png
cmp "$mobile/assets/icon.png" "$root/app/src/main/res/drawable-nodpi/switchboard_icon.png"
cmp "$mobile/assets/adaptive-icon.png" "$root/app/src/main/res/drawable-nodpi/switchboard_adaptive_icon.png"

while IFS='|' read -r source target; do
  require_file "app/src/main/res/font/$target"
  cmp "$mobile/node_modules/@expo-google-fonts/$source" "$root/app/src/main/res/font/$target"
done <<'FONTS'
instrument-sans/600SemiBold/InstrumentSans_600SemiBold.ttf|instrument_sans_semibold.ttf
instrument-sans/700Bold/InstrumentSans_700Bold.ttf|instrument_sans_bold.ttf
geist-mono/400Regular/GeistMono_400Regular.ttf|geist_mono_regular.ttf
geist-mono/500Medium/GeistMono_500Medium.ttf|geist_mono_medium.ttf
FONTS

echo "scaffold source contract passed"
