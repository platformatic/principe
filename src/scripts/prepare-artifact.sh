#!/bin/bash

set -euo pipefail

if [[ -f .env ]]; then
  set -a
  source .env
  set +a
fi

platform="${1:?platform is required}"
arch="${2:?arch is required}"
extension=""

if [[ "$platform" == "windows" ]]; then
  extension=".exe"
fi

if [[ ! "$platform" =~ ^(macos|darwin|linux|windows)$ || ! "$arch" =~ ^(arm64|x64)$ ]]; then
  echo "Unsupported artifact platform or architecture."
  exit 1
fi

source="dist/principe$extension"
artifact_dir="tmp/artifact-$platform-$arch"
target="$artifact_dir/principe$extension"

if [[ ! -f "$source" ]]; then
  echo "Artifact source not found: $source"
  exit 1
fi

if [[ ! -s LICENSE || ! -s THIRD_PARTY_NOTICES ]]; then
  echo "Distribution license files are missing or empty."
  exit 1
fi

# Rebuild only this platform/architecture's staging directory from the completed executable.
rm -rf "$artifact_dir"
mkdir -p "$artifact_dir"
cp "$source" "$target"

chmod a+x "$target"

# Copy repository license texts verbatim alongside the executable.
cp LICENSE THIRD_PARTY_NOTICES "$artifact_dir/"
