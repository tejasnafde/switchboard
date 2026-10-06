#!/usr/bin/env bash
# Usage: verify-release-assets.sh <tag> <owner/repo> <mac|win>
# Asserts one platform's install and auto-update assets are on the release and
# that its update manifest names this version. Run by release.yml.
set -euo pipefail
TAG="$1"; REPO="$2"; PLATFORM="$3"
V="${TAG#v}"
case "$PLATFORM" in
  mac) REQUIRED=("Switchboard-${V}-arm64-mac.zip" "Switchboard-${V}-arm64-mac.zip.blockmap" "latest-mac.yml"); MANIFEST=latest-mac.yml ;;
  win) REQUIRED=("Switchboard-Setup-${V}.exe" "Switchboard-${V}-win.zip" "latest.yml"); MANIFEST=latest.yml ;;
  *) echo "unknown platform $PLATFORM" >&2; exit 2 ;;
esac

# The Releases API reads through a cache, so retry briefly rather than fail a good release.
missing=""
for attempt in 1 2 3; do
  names="$(gh release view "$TAG" --repo "$REPO" --json assets --jq '.assets[].name')"
  missing=""
  for want in "${REQUIRED[@]}"; do grep -Fxq "$want" <<< "$names" || missing="$missing $want"; done
  [ -z "$missing" ] && break
  echo "attempt $attempt: not yet present:$missing"
  sleep 15
done
if [ -n "$missing" ]; then
  echo "::error::Release $TAG is missing:$missing"
  echo "Clients will not see this version. Re-run the failed build job."
  exit 1
fi

# A manifest that names the wrong version looks like "up to date" to a client.
tmp="$(mktemp -d)"
gh release download "$TAG" --repo "$REPO" --dir "$tmp" --pattern "$MANIFEST" --clobber
y="$tmp/$MANIFEST"
grep -q "^version: ${V}$" "$y" || { echo "::error::$MANIFEST does not declare version ${V}"; cat "$y"; exit 1; }
if [ "$PLATFORM" = mac ] && ! grep -q "^minimumSystemVersion: 21.0.0$" "$y"; then
  echo "::error::latest-mac.yml does not protect macOS 11 clients from the Electron 43 runtime floor"
  cat "$y"; exit 1
fi
echo "$MANIFEST declares version ${V}; all $PLATFORM assets present"
