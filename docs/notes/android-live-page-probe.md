# Android live page probe: manual steps

The Android default of `phone_html_live_run` (Settings > Labs > Run live pages,
`BuildConfig.PHONE_HTML_LIVE_RUN` in `apps/android/app/build.gradle.kts`) stays
`false` until `LivePageProbeTest` passes on a real device. The plan asks for two
devices: one current phone and one old phone (2 GB RAM, Android 8 or 9). This
note gives the exact steps. Nobody has run them yet (2026-11-03: no device was
on adb).

The steps install only the debug build (`app.tn07.switchboard.native.dev`) and
its test APK. They do not touch the Play build (`app.tn07.switchboard`), they
uninstall nothing, and they type nothing into a chat.

## 1. Connect the phone over wireless adb

1. Put the phone and the Mac on the same Wi-Fi network.
2. On the phone, open Settings > About device > Version and tap Build number
   seven times to turn on Developer options (once per phone).
3. Open Settings > System > Developer options > Wireless debugging and turn it on.
4. The first time only, tap "Pair device with pairing code". On the Mac, run
   `adb pair <ip>:<pairing port>` and type the six-digit code.
5. On the Mac, run `adb connect <ip>:<port>`. Use the IP address and port that
   the Wireless debugging screen shows (not the pairing port).
6. Run `adb devices -l`. The phone must show as `device`, not `unauthorized`
   or `offline`.

## 2. Build and install the debug app and its test APK

Run gradle only between 01:00 and 08:00 IST (the Mac is in use during the day).

```sh
cd apps/android
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
nice -n 19 ./gradlew --no-daemon --max-workers=2 installDebug installDebugAndroidTest
```

A new worktree needs `apps/android/local.properties`: copy it from the main
checkout.

## 3. Run the probe

Use `am instrument`, not `connectedDebugAndroidTest`. The gradle task
uninstalls both APKs when it ends.

```sh
adb shell am instrument -w -r \
  -e class app.switchboard.mobile.ui.thread.LivePageProbeTest \
  app.tn07.switchboard.native.dev.test/androidx.test.runner.AndroidJUnitRunner \
  | tee /tmp/live-probe-$(adb shell getprop ro.product.model | tr -d '\r ').txt
```

The run passes when the output ends with `OK (N tests)`. It fails on any
`PROBE <name> LEAK` line, on any connection to the test's loopback listener, on
a started activity, or on a page that does not finish. Keep the output file.

## 4. Record memory

While the probe runs, read the memory of the test process twice: once during
the chart page and once with three pages open.

```sh
adb shell dumpsys meminfo app.tn07.switchboard.native.dev | head -40
```

Write the TOTAL PSS values down.

## 5. Record the result

1. In `docs/feature-parity/phone-html-live-run.json`, add a line to
   `verification.hardware` for each device: the model, the Android version, the
   RAM, the date, the `OK (N tests)` line and the two memory values. Remove the
   matching entry from `notExercised`.
2. When the probe passes on both devices, set `PHONE_HTML_LIVE_RUN` to `true`
   in `apps/android/app/build.gradle.kts`, and move the `nativeAndroid` surface
   to `implemented` (plan PR 6). iOS stays off until the probe page passes on
   a real iPhone.
3. If any line says LEAK, keep the flag off and open an issue with the output
   file.
