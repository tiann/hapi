#!/usr/bin/env bash
# Dedicated disposable emulator. Never install into a connected personal device.
set -euo pipefail
cd "$(dirname "$0")/.."
sdk=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}
if [ -z "$sdk" ] && [ -f local.properties ]; then sdk=$(sed -n 's/^sdk.dir=//p' local.properties); fi
: "${sdk:?Set ANDROID_HOME to an installed Android SDK}"
export ANDROID_HOME="$sdk"
output=${HAPI_PROFILE_OUTPUT:-$(mktemp -d /tmp/hapi-android-frames.XXXXXX)}
mkdir -p "$output"
output=$(cd "$output" && pwd)
export ANDROID_AVD_HOME
ANDROID_AVD_HOME=$(mktemp -d /tmp/hapi-profile-avd.XXXXXX)
serial=emulator-5584
pid=
cleanup() {
    if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
    rm -rf "$ANDROID_AVD_HOME"
}
trap cleanup EXIT
adb="$sdk/platform-tools/adb"
if "$adb" devices | grep -q "$serial"; then echo 'Test port occupied; refusing existing device'; exit 1; fi
./gradlew -PhapiTestBuildType=profile :app:assembleProfile :app:assembleProfileAndroidTest > "$output/build.log" 2>&1
system_image=${HAPI_PROFILE_SYSTEM_IMAGE:-system-images;android-35;google_apis_playstore;arm64-v8a}
printf 'no\n' | "$sdk/cmdline-tools/latest/bin/avdmanager" create avd -n HapiFrameProfile -k "$system_image" -p "$ANDROID_AVD_HOME/device"
cat >> "$ANDROID_AVD_HOME/device/config.ini" <<'EOF'
hw.lcd.width=1080
hw.lcd.height=1920
hw.lcd.density=420
hw.gpu.enabled=yes
EOF
gpu=${HAPI_PROFILE_GPU:-host}
printf 'system_image=%s\ngpu=%s\nbuild=profile (non-debuggable, unminified)\n' "$system_image" "$gpu" > "$output/environment.txt"
"$sdk/emulator/emulator" -avd HapiFrameProfile -no-window -no-audio -no-snapshot -no-boot-anim \
    -gpu "$gpu" -port 5584 -memory 4096 -cores 4 > "$output/emulator.log" 2>&1 &
pid=$!
booted=false
for attempt in $(seq 1 120); do
    if [ "$("$adb" -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ]; then booted=true; break; fi
    if ! kill -0 "$pid" 2>/dev/null; then cat "$output/emulator.log"; exit 1; fi
    sleep 2
done
if [ "$booted" != true ]; then echo 'Emulator boot timed out'; exit 1; fi
"$adb" -s "$serial" shell input keyevent 82
"$adb" -s "$serial" shell settings put system screen_off_timeout 600000
# Synthetic UI needs no network. Avoid freshly booted Play Store downloads /
# dexopt competing with the app; this is ONLY our disposable emulator.
"$adb" -s "$serial" shell cmd connectivity airplane-mode enable
"$adb" -s "$serial" shell pm disable-user --user 0 com.android.vending >> "$output/environment.txt" 2>&1 || true
"$adb" -s "$serial" shell dumpsys SurfaceFlinger > "$output/surfaceflinger.txt"
"$adb" -s "$serial" install -r -t app/build/outputs/apk/profile/app-profile.apk
"$adb" -s "$serial" install -r -t app/build/outputs/apk/androidTest/profile/app-profile-androidTest.apk
sleep 30 # keep install/boot work out of the measured intervals
"$adb" -s "$serial" logcat -c
if [ "${HAPI_PROFILE_TRACE:-0}" = 1 ]; then
    cat > "$output/perfetto.config" <<'EOF'
buffers { size_kb: 262144 fill_policy: RING_BUFFER }
duration_ms: 180000
data_sources { config { name: "android.surfaceflinger.frametimeline" } }
data_sources {
    config {
        name: "linux.ftrace"
        ftrace_config {
            atrace_apps: "run.hapi.companion"
            atrace_categories: "gfx"
            atrace_categories: "view"
            ftrace_events: "sched/sched_switch"
            ftrace_events: "sched/sched_waking"
        }
    }
}
data_sources { config { name: "linux.process_stats" } }
EOF
    # Perfetto's SELinux domain cannot read /data/local/tmp on user images.
    "$adb" -s "$serial" shell perfetto --background-wait --txt -c - \
        -o /data/misc/perfetto-traces/hapi-scroll.pftrace < "$output/perfetto.config" > "$output/perfetto-start.txt"
fi
"$adb" -s "$serial" shell am instrument -w -r -e hapiScrollProfile true \
    -e class app.hapi.companion.feature.chat.ChatFrameProfileTest \
    run.hapi.companion.test/androidx.test.runner.AndroidJUnitRunner | tee "$output/instrumentation.log"
"$adb" -s "$serial" pull /sdcard/Android/data/run.hapi.companion/files/scroll-profile "$output/"
if [ "${HAPI_PROFILE_TRACE:-0}" = 1 ]; then
    trace_pid=$(tr -d '\r' < "$output/perfetto-start.txt" | awk '/^[0-9]+$/ {print $1}')
    if [ -n "$trace_pid" ]; then "$adb" -s "$serial" shell kill -INT "$trace_pid"; fi
    sleep 3
    "$adb" -s "$serial" pull /data/misc/perfetto-traces/hapi-scroll.pftrace "$output/"
fi
"$adb" -s "$serial" logcat -d > "$output/logcat.txt"
grep HapiFrameProfile "$output/logcat.txt" || true
grep -q '^OK (' "$output/instrumentation.log"
echo "Profile artifacts: $output"
