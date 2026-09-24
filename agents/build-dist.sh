#!/usr/bin/env bash
# Kopira artefakte iz CI-ja (GitHub Actions, workflow „MDM agenti") u agents/dist/,
# odakle ih poslužitelj nudi na /api/mdm/agent/download/*:
#   dist/android/app-release.apk   dist/windows/wms-agent.zip   dist/windows/install.ps1
#
# Upotreba:
#   agents/build-dist.sh                 # zadnji uspješni run na grani main (traži gh CLI)
#   agents/build-dist.sh -b main         # druga grana
#   agents/build-dist.sh -r 1234567890   # određeni run
#   agents/build-dist.sh -d ~/Downloads  # već preuzeti/raspakirani artefakti (mape mdm-agent-android, mdm-agent-windows ili zip-ovi)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DIST="$HERE/dist"
BRANCH="main"
RUN_ID=""
SRC=""
while getopts "b:r:d:h" o; do
  case "$o" in
    b) BRANCH="$OPTARG" ;;
    r) RUN_ID="$OPTARG" ;;
    d) SRC="$OPTARG" ;;
    *) sed -n '2,12p' "$0"; exit 0 ;;
  esac
done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ -z "$SRC" ]; then
  command -v gh >/dev/null || { echo "Treba GitHub CLI (gh) ili -d <mapa s artefaktima>"; exit 1; }
  if [ -z "$RUN_ID" ]; then
    RUN_ID="$(gh run list --workflow mdm-agents.yml --branch "$BRANCH" --status success --limit 1 --json databaseId -q '.[0].databaseId')"
    [ -n "$RUN_ID" ] || { echo "Nema uspješnog runa na grani $BRANCH"; exit 1; }
  fi
  echo "Preuzimam artefakte runa $RUN_ID …"
  gh run download "$RUN_ID" -n mdm-agent-android -D "$TMP/mdm-agent-android"
  gh run download "$RUN_ID" -n mdm-agent-windows -D "$TMP/mdm-agent-windows"
  SRC="$TMP"
else
  # raspakiraj zip-ove preuzete iz web sučelja
  for z in "$SRC"/*.zip; do [ -e "$z" ] || continue; mkdir -p "$TMP/$(basename "$z" .zip)"; unzip -oq "$z" -d "$TMP/$(basename "$z" .zip)"; done
  cp -r "$SRC"/. "$TMP"/ 2>/dev/null || true
  SRC="$TMP"
fi

mkdir -p "$DIST/android" "$DIST/windows"
APK="$(find "$SRC" -name 'app-release.apk' | head -1)"
if [ -z "$APK" ]; then
  APK="$(find "$SRC" -name '*.apk' | head -1)"
  [ -n "$APK" ] && echo "UPOZORENJE: nema potpisanog release APK-a — kopiram $(basename "$APK") (debug potpis, QR checksum nije stalan)"
fi
[ -n "$APK" ] || { echo "Nema APK-a u artefaktima"; exit 1; }
cp "$APK" "$DIST/android/app-release.apk"
SIG="$(find "$SRC" -name 'signature-checksum.txt' | head -1)"
[ -n "$SIG" ] && cp "$SIG" "$DIST/android/signature-checksum.txt"

ZIP="$(find "$SRC" -name 'wms-agent.zip' | head -1)"
PS1="$(find "$SRC" -name 'install.ps1' -path '*windows*' | head -1)"
[ -n "$ZIP" ] && [ -n "$PS1" ] || { echo "Nema Windows artefakata (wms-agent.zip, install.ps1)"; exit 1; }
cp "$ZIP" "$DIST/windows/wms-agent.zip"
cp "$PS1" "$DIST/windows/install.ps1"

echo "Gotovo:"
( cd "$DIST" && find . -type f -exec sha256sum {} \; )
[ -f "$DIST/android/signature-checksum.txt" ] && echo "PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM: $(cat "$DIST/android/signature-checksum.txt")"
exit 0
