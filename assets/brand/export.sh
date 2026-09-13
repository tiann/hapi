#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$ROOT/../.." && pwd)"
SVG="$ROOT/svg"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/hapi-brand.XXXXXX")"

cleanup() {
    rm -rf "$OUT"
}
trap cleanup EXIT

command -v magick >/dev/null 2>&1 || {
    echo "ImageMagick (magick) is required" >&2
    exit 1
}

mkdir -p "$OUT/web" "$OUT/native/android" "$OUT/native/ios"

render() {
    local source="$1"
    local size="$2"
    local target="$3"
    magick -background none "$source" -resize "${size}x${size}" -depth 8 -strip "PNG32:$target"
}

render_rgb() {
    local source="$1"
    local size="$2"
    local target="$3"
    magick \
        -background '#FFF8F8' \
        "$source" \
        -resize "${size}x${size}" \
        -alpha remove \
        -alpha off \
        -colorspace sRGB \
        -type TrueColor \
        -depth 8 \
        -strip \
        "PNG24:$target"
}

render_round() {
    local source="$1"
    local size="$2"
    local target="$3"
    local radius=$((size / 2))

    magick \
        -background none \
        "$source" \
        -resize "${size}x${size}" \
        \( -size "${size}x${size}" canvas:none -fill white -draw "circle ${radius},${radius} ${radius},0" \) \
        -alpha off \
        -compose CopyOpacity \
        -composite \
        -depth 8 \
        -strip \
        "PNG32:$target"
}

copy_asset() {
    local source="$1"
    local target="$2"
    mkdir -p "$(dirname "$target")"
    cp "$source" "$target"
}

# Favicon optical sizes. The 16px master intentionally simplifies the
# handoff ports; 32px and above retain their negative angle brackets.
render "$SVG/hapi-tiny.svg" 16 "$OUT/web/favicon-16x16.png"
for size in 32 48; do
    render "$SVG/hapi-small.svg" "$size" "$OUT/web/favicon-${size}x${size}.png"
done

magick \
    "$OUT/web/favicon-16x16.png" \
    "$OUT/web/favicon-32x32.png" \
    "$OUT/web/favicon-48x48.png" \
    "$OUT/web/favicon.ico"

# Web/PWA and Apple touch assets reuse the established small-size optical
# master. Opaque RGB output avoids an extra alpha-compositing pass on install.
for size in 64 180 192 512; do
    render_rgb "$SVG/hapi-small.svg" "$size" "$OUT/web/hapi-pwa-${size}x${size}.png"
done

for size in 192 512; do
    render_rgb "$SVG/hapi-maskable.svg" "$size" "$OUT/web/hapi-maskable-${size}x${size}.png"
done

# Android legacy launcher assets. API 26+ adaptive and Android 13+ themed
# vector layers remain native resources under android/app/src/main/res/.
while IFS=: read -r density size; do
    directory="$OUT/native/android/mipmap-$density"
    mkdir -p "$directory"
    render "$SVG/hapi-small.svg" "$size" "$directory/ic_launcher.png"
    render_round "$SVG/hapi-app-icon.svg" "$size" "$directory/ic_launcher_round.png"
done <<'EOF'
mdpi:48
hdpi:72
xhdpi:96
xxhdpi:144
xxxhdpi:192
EOF

# Legacy iOS/App Store fallback: opaque RGB, no alpha channel. Xcode 26 uses
# the layered AppIcon.icon package copied below instead.
render_rgb "$SVG/hapi-small.svg" 1024 "$OUT/native/ios/AppIcon.png"

# Web application.
copy_asset "$OUT/web/favicon.ico" "$REPO_ROOT/web/public/favicon.ico"
copy_asset "$SVG/hapi-small.svg" "$REPO_ROOT/web/public/icon.svg"
copy_asset "$SVG/hapi-monochrome.svg" "$REPO_ROOT/web/public/mask-icon.svg"
copy_asset "$OUT/web/hapi-pwa-180x180.png" "$REPO_ROOT/web/public/apple-touch-icon-180x180.png"
copy_asset "$OUT/web/hapi-pwa-64x64.png" "$REPO_ROOT/web/public/pwa-64x64.png"
copy_asset "$OUT/web/hapi-pwa-192x192.png" "$REPO_ROOT/web/public/pwa-192x192.png"
copy_asset "$OUT/web/hapi-pwa-512x512.png" "$REPO_ROOT/web/public/pwa-512x512.png"
copy_asset "$OUT/web/hapi-maskable-192x192.png" "$REPO_ROOT/web/public/pwa-maskable-192x192.png"
copy_asset "$OUT/web/hapi-maskable-512x512.png" "$REPO_ROOT/web/public/pwa-maskable-512x512.png"

# Documentation and marketing website.
copy_asset "$OUT/web/favicon.ico" "$REPO_ROOT/docs/public/favicon.ico"
copy_asset "$SVG/hapi-mark.svg" "$REPO_ROOT/docs/public/logo.svg"
copy_asset "$OUT/web/favicon.ico" "$REPO_ROOT/website/public/favicon.ico"
copy_asset "$SVG/hapi-small.svg" "$REPO_ROOT/website/public/icon.svg"
copy_asset "$SVG/hapi-mark.svg" "$REPO_ROOT/website/public/logo.svg"
copy_asset "$OUT/web/hapi-pwa-180x180.png" "$REPO_ROOT/website/public/apple-touch-icon-180x180.png"

# Native application assets.
while IFS=: read -r density _size; do
    source="$OUT/native/android/mipmap-$density"
    target="$REPO_ROOT/android/app/src/main/res/mipmap-$density"
    copy_asset "$source/ic_launcher.png" "$target/ic_launcher.png"
    copy_asset "$source/ic_launcher_round.png" "$target/ic_launcher_round.png"
done <<'EOF'
mdpi:48
hdpi:72
xhdpi:96
xxhdpi:144
xxxhdpi:192
EOF

copy_asset \
    "$OUT/native/ios/AppIcon.png" \
    "$REPO_ROOT/ios/Hapi/Assets.xcassets/AppIcon.appiconset/AppIcon.png"
copy_asset \
    "$SVG/hapi-optical-mark.svg" \
    "$REPO_ROOT/ios/Hapi/AppIcon.icon/Assets/hapi-optical-mark.svg"

echo "Synced HAPI brand assets from $ROOT"
