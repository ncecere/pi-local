#!/usr/bin/env bash
# Builds "Pi Local.app": the desktop binary, the agent runtime embedded in it, and a pinned Node binary
# (downloaded from nodejs.org and checked against its published SHA-256) in Contents/Resources/node.
#
#   packaging/macos/package.sh                 # ad-hoc signed, for this Mac
#   SIGN_IDENTITY="Developer ID Application: …" packaging/macos/package.sh   # hardened runtime, for notarizing
set -euo pipefail
cd "$(dirname "$0")/../.."

VERSION="${VERSION:-$(git describe --tags --always --dirty 2>/dev/null | sed 's/^v//')}"
NODE_VERSION="${NODE_VERSION:-22.23.0}"
case "$(uname -m)" in arm64) NODE_ARCH=arm64 ;; x86_64) NODE_ARCH=x64 ;; *) echo "unsupported arch"; exit 1 ;; esac
OUT="${OUT:-dist/macos}"
APP="$OUT/Pi Local.app"
CACHE=".cache/node"

echo "→ Pi Local $VERSION, Node $NODE_VERSION ($NODE_ARCH)"

# 1. Node, verified.
TARBALL="node-v$NODE_VERSION-darwin-$NODE_ARCH.tar.gz"
mkdir -p "$CACHE"
if [ ! -f "$CACHE/$TARBALL" ]; then
	curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$TARBALL" -o "$CACHE/$TARBALL.part"
	mv "$CACHE/$TARBALL.part" "$CACHE/$TARBALL"
fi
curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$CACHE/SHASUMS256-$NODE_VERSION.txt"
want="$(grep " $TARBALL\$" "$CACHE/SHASUMS256-$NODE_VERSION.txt" | cut -d' ' -f1)"
got="$(shasum -a 256 "$CACHE/$TARBALL" | cut -d' ' -f1)"
if [ -z "$want" ] || [ "$want" != "$got" ]; then
	echo "✗ $TARBALL doesn't match nodejs.org's SHA-256 ($got vs ${want:-none}); removing it"
	rm -f "$CACHE/$TARBALL"
	exit 1
fi
echo "✓ Node verified ($got)"

# 2. The runtime bundle, the UI, and the binary (both embedded).
make runtime frontend >/dev/null
export MACOSX_DEPLOYMENT_TARGET=11.0 CGO_LDFLAGS="-mmacosx-version-min=11.0"
go build -trimpath -ldflags "-s -w -X github.com/ncecere/pi-local/internal/app.Version=$VERSION" -o "$OUT/pi-local" ./cmd/pi-local

# 3. The bundle.
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
mv "$OUT/pi-local" "$APP/Contents/MacOS/pi-local"
tar -xzf "$CACHE/$TARBALL" -C "$OUT" "node-v$NODE_VERSION-darwin-$NODE_ARCH/bin/node" "node-v$NODE_VERSION-darwin-$NODE_ARCH/LICENSE"
mv "$OUT/node-v$NODE_VERSION-darwin-$NODE_ARCH/bin/node" "$APP/Contents/Resources/node"
mv "$OUT/node-v$NODE_VERSION-darwin-$NODE_ARCH/LICENSE" "$APP/Contents/Resources/node-LICENSE"
rm -rf "$OUT/node-v$NODE_VERSION-darwin-$NODE_ARCH"

ICONSET="$OUT/icon.iconset"
rm -rf "$ICONSET"; mkdir -p "$ICONSET"
for size in 16 32 64 128 256 512; do
	sips -z $size $size frontend/public/icon-512.png --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
	double=$((size * 2)); [ $double -le 1024 ] && sips -z $double $double frontend/public/icon-512.png --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/icon.icns"
rm -rf "$ICONSET"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key><string>Pi Local</string>
	<key>CFBundleDisplayName</key><string>Pi Local</string>
	<key>CFBundleIdentifier</key><string>dev.bitop.pi-local</string>
	<key>CFBundleExecutable</key><string>pi-local</string>
	<key>CFBundleIconFile</key><string>icon</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>${VERSION%%-*}</string>
	<key>CFBundleVersion</key><string>$VERSION</string>
	<key>LSMinimumSystemVersion</key><string>11.0</string>
	<key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
	<key>NSHighResolutionCapable</key><true/>
	<key>NSHumanReadableCopyright</key><string>MIT licensed. Includes Node.js (see Resources/node-LICENSE).</string>
</dict>
</plist>
PLIST

# 4. Signing: ad-hoc for this Mac, or a Developer ID with the hardened runtime (Node needs JIT).
if [ -n "${SIGN_IDENTITY:-}" ]; then
	codesign --force --timestamp --options runtime --entitlements packaging/macos/entitlements.plist -s "$SIGN_IDENTITY" "$APP/Contents/Resources/node"
	codesign --force --timestamp --options runtime --entitlements packaging/macos/entitlements.plist -s "$SIGN_IDENTITY" "$APP"
else
	codesign --force -s - "$APP/Contents/Resources/node"
	codesign --force -s - "$APP"
fi
codesign --verify --deep --strict "$APP"
echo "✓ $APP ($(du -sh "$APP" | cut -f1))"
