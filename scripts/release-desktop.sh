#!/usr/bin/env bash
set -euo pipefail

REPO="timing/eise.app"
BUILDER_CONFIG="electron-builder.yml"

# --- Version: date-based from today ---
VERSION=$(date +%Y.%m.%d)
TAG="v${VERSION}"

echo "=== Eise Desktop Release ${VERSION} ==="

# --- Check prerequisites ---
if ! command -v gh &>/dev/null; then
  echo "Error: gh (GitHub CLI) is required. Install with: brew install gh"
  exit 1
fi

if ! gh auth status &>/dev/null 2>&1; then
  echo "Error: Not logged in to GitHub. Run: gh auth login"
  exit 1
fi

# --- Check if this version already exists ---
if gh release view "$TAG" --repo "$REPO" &>/dev/null 2>&1; then
  echo "Release ${TAG} already exists. Bump with a suffix? (e.g., ${VERSION}.1)"
  read -rp "Enter version [${VERSION}]: " NEW_VERSION
  VERSION="${NEW_VERSION:-$VERSION}"
  TAG="v${VERSION}"
fi

# --- Validate version format (digits and dots only) ---
if [[ ! "$VERSION" =~ ^[0-9]+(\.[0-9]+)*$ ]]; then
  echo "Error: Invalid version format '${VERSION}'. Must be digits and dots only (e.g., 2026.05.20)."
  exit 1
fi

echo ""
echo "Building version: ${VERSION}"
echo ""

# --- Update version in package.json ---
cd "$(dirname "$0")/.."

node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = process.argv[1];
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
console.log('Updated package.json version to ' + process.argv[1]);
" "$VERSION"

# --- Generate static files (includes version.json via postgenerate) ---
# EISE_BUILD_TARGET=electron matches npm run electron:build so the bundle baked
# into every desktop release is identical to a local electron:build. Without
# this, the release script would produce a web-flavored bundle and the desktop
# app would report analytics as the web build until it auto-updated.
echo ""
echo "=== Running nuxt generate (electron target) ==="
EISE_BUILD_TARGET=electron npm run generate

# --- Clean previous build artifacts ---
DIST="electron-dist"
rm -rf "$DIST"

# --- Build for all platforms ---
echo ""
echo "=== Building macOS ==="
npx electron-builder --mac --config "$BUILDER_CONFIG"

echo ""
echo "=== Building Windows ==="
npx electron-builder --win --config "$BUILDER_CONFIG"

echo ""
echo "=== Building Linux ==="
npx electron-builder --linux --config "$BUILDER_CONFIG"

# --- Collect built files ---
DMG=""
EXE_X64=""
EXE_ARM64=""
APPIMAGE=""
DEB=""

# electron-builder emits three Windows installers when both x64 and arm64 are
# configured: `-win-x64.exe`, `-win-arm64.exe`, and a fatter combined `-win.exe`.
# We ship the two per-arch installers and skip the combined one (368MB vs 200MB).
while IFS= read -r -d '' f; do
  case "$f" in
    *.blockmap) continue ;;
    *uninstaller*) continue ;;
    *.dmg)              [ -z "$DMG" ] && DMG="$f" ;;
    *-win-x64.exe)      [ -z "$EXE_X64" ] && EXE_X64="$f" ;;
    *-win-arm64.exe)    [ -z "$EXE_ARM64" ] && EXE_ARM64="$f" ;;
    *.AppImage)         [ -z "$APPIMAGE" ] && APPIMAGE="$f" ;;
    *.deb)              [ -z "$DEB" ] && DEB="$f" ;;
  esac
done < <(find "$DIST" -maxdepth 1 -type f -print0)

echo ""
echo "=== Built artifacts ==="
for f in "$DMG" "$EXE_X64" "$EXE_ARM64" "$APPIMAGE" "$DEB"; do
  if [ -n "$f" ] && [ -f "$f" ]; then
    echo "  $(basename "$f") ($(du -h "$f" | cut -f1 | xargs))"
  fi
done

# --- Create GitHub Release ---
echo ""
echo "=== Creating GitHub Release ${TAG} ==="

ASSETS=()
[ -n "$DMG" ]       && [ -f "$DMG" ]       && ASSETS+=("$DMG")
[ -n "$EXE_X64" ]   && [ -f "$EXE_X64" ]   && ASSETS+=("$EXE_X64")
[ -n "$EXE_ARM64" ] && [ -f "$EXE_ARM64" ] && ASSETS+=("$EXE_ARM64")
[ -n "$APPIMAGE" ]  && [ -f "$APPIMAGE" ]  && ASSETS+=("$APPIMAGE")
[ -n "$DEB" ]       && [ -f "$DEB" ]       && ASSETS+=("$DEB")

gh release create "$TAG" "${ASSETS[@]}" \
  --repo "$REPO" \
  --title "Eise ${VERSION}" \
  --notes "$(cat <<EOF
Desktop release ${VERSION}

**Downloads:**
- **macOS:** $(basename "$DMG")
- **Windows (x64):** $(basename "$EXE_X64")
- **Windows (ARM64):** $(basename "$EXE_ARM64")
- **Linux:** $(basename "$APPIMAGE") / $(basename "$DEB")

All processing happens locally on your machine, no data is uploaded.
Auto-updates are built in: the app checks for web updates in the background.
EOF
)"

echo ""
echo "=== Updating download page ==="

# --- Update download.vue with current release URLs and version ---
# Pass all values as arguments to node, not via string interpolation
node -e "
const fs = require('fs');
const [version, baseUrl, dmgName, exeX64Name, exeArm64Name, appImageName, debName] = process.argv.slice(1);
let page = fs.readFileSync('pages/download.vue', 'utf8');

const urlBlock = [
  \"const RELEASE_VERSION = '\" + version + \"';\",
  'const DOWNLOAD_URLS = {',
  \"  mac: '\" + baseUrl + '/' + dmgName + \"',\",
  \"  windows: '\" + baseUrl + '/' + encodeURIComponent(exeX64Name) + \"',\",
  \"  windowsArm64: '\" + baseUrl + '/' + encodeURIComponent(exeArm64Name) + \"',\",
  \"  linux: '\" + baseUrl + '/' + appImageName + \"',\",
  \"  deb: '\" + baseUrl + '/' + debName + \"',\",
  '};',
].join('\n');

if (page.includes('const RELEASE_VERSION')) {
  page = page.replace(/const RELEASE_VERSION[\s\S]*?};/m, urlBlock);
} else {
  page = page.replace('<script setup>', '<script setup>\n' + urlBlock + '\n');
}

fs.writeFileSync('pages/download.vue', page);
console.log('Updated pages/download.vue');
" "$VERSION" "https://github.com/${REPO}/releases/latest/download" \
  "$(basename "$DMG")" "$(basename "$EXE_X64")" "$(basename "$EXE_ARM64")" "$(basename "$APPIMAGE")" "$(basename "$DEB")"

echo ""
echo "=== Done! ==="
echo "Release: https://github.com/${REPO}/releases/tag/${TAG}"
echo ""
echo "Don't forget to commit the updated download.vue and package.json!"
