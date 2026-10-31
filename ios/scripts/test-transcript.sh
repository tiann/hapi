#!/usr/bin/env bash
# Isolated app-hosted UIKit layout tests; never installs into a user's device.
set -euo pipefail
cd "$(dirname "$0")/../.."

device_type=${HAPI_TEST_DEVICE_TYPE:-com.apple.CoreSimulator.SimDeviceType.iPhone-15}
# Newest iOS runtime that offers the device type (some runtimes ship for
# a single device, e.g. iOS 27.1 for iPhone Duo).
runtime=$(xcrun simctl list runtimes -j | python3 -c '
import json, sys
device_type = sys.argv[1]
items = [x for x in json.load(sys.stdin)["runtimes"]
         if x.get("isAvailable") and x.get("name", "").startswith("iOS")
         and any(d["identifier"] == device_type for d in x.get("supportedDeviceTypes", []))]
print(max(items, key=lambda x: tuple(map(int, x["version"].split("."))))["identifier"])
' "$device_type")
device=$(xcrun simctl create "HAPI Transcript Tests" "$device_type" "$runtime")
trap 'xcrun simctl delete "$device" >/dev/null 2>&1 || true' EXIT

xcodebuild test -project ios/Hapi.xcodeproj -scheme Hapi \
    -destination "platform=iOS Simulator,id=$device" \
    -derivedDataPath "${HAPI_TEST_DERIVED_DATA:-/tmp/hapi-transcript-tests}" \
    -parallel-testing-enabled NO CODE_SIGNING_ALLOWED=NO "$@"
