#!/bin/bash

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS notarization can only run on macOS."
  exit 1
fi

EXECUTABLE_PATH="${1:-dist/principe}"
ARCHIVE_PATH="${2:-dist/principe-notarization.zip}"
ENTITLEMENTS_PATH="${ENTITLEMENTS_PATH:-src/sea/entitlements.plist}"
KEYCHAIN_PASSWORD="${APPLE_KEYCHAIN_PASSWORD:-$(uuidgen)}"

if [[ ! -f "$EXECUTABLE_PATH" || ! -f "$ENTITLEMENTS_PATH" ]]; then
  echo "Executable or entitlements file not found."
  exit 1
fi

: "${CSC_LINK:?CSC_LINK is required}"
: "${CSC_KEY_PASSWORD:?CSC_KEY_PASSWORD is required}"
: "${APPLE_ID:?APPLE_ID is required}"
: "${APPLE_APP_SPECIFIC_PASSWORD:?APPLE_APP_SPECIFIC_PASSWORD is required}"
: "${APPLE_TEAM_ID:?APPLE_TEAM_ID is required}"

# Keep signing material in project staging rather than a global temporary path.
mkdir -p tmp
TEMP_DIR="$(mktemp -d "$PWD/tmp/principe-signing-XXXXXX")"
KEYCHAIN_PATH="$TEMP_DIR/principe-signing.keychain-db"
CERTIFICATE_PATH="$TEMP_DIR/principe-certificate.p12"

cleanup () {
  security delete-keychain "$KEYCHAIN_PATH" >/dev/null 2>&1 || true
  rm -f "$CERTIFICATE_PATH" "$ARCHIVE_PATH"
  rmdir "$TEMP_DIR" 2>/dev/null || true
}
trap cleanup EXIT

# Accept either a certificate path or the base64 payload used by CI secrets.
if [[ -f "$CSC_LINK" ]]; then
  cp "$CSC_LINK" "$CERTIFICATE_PATH"
else
  printf '%s' "$CSC_LINK" | base64 --decode > "$CERTIFICATE_PATH"
fi

# Isolate imported signing credentials in a temporary keychain removed by the exit trap.
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
security set-keychain-settings -lut 21600 "$KEYCHAIN_PATH"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
security import "$CERTIFICATE_PATH" -P "$CSC_KEY_PASSWORD" -A -t cert -f pkcs12 -k "$KEYCHAIN_PATH"
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"

SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
if [[ -z "$SIGNING_IDENTITY" ]]; then
  SIGNING_IDENTITY=$(security find-identity -v -p codesigning "$KEYCHAIN_PATH" | sed -n 's/.*"\(Developer ID Application:.*\)"/\1/p' | head -n 1)
fi

if [[ -z "$SIGNING_IDENTITY" ]]; then
  echo "Unable to find a Developer ID Application signing identity."
  exit 1
fi

# Sign and verify before submitting the archive for notarization.
codesign --force --timestamp --options runtime --keychain "$KEYCHAIN_PATH" --entitlements "$ENTITLEMENTS_PATH" --sign "$SIGNING_IDENTITY" "$EXECUTABLE_PATH"
codesign --verify --strict --verbose=2 "$EXECUTABLE_PATH"
ditto -c -k --keepParent "$EXECUTABLE_PATH" "$ARCHIVE_PATH"
xcrun notarytool submit "$ARCHIVE_PATH" \
  --apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" --wait
