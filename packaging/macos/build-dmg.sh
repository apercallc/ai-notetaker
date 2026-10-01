#!/bin/bash
set -euo pipefail
app=${1:?Usage: build-dmg.sh APP_PATH OUTPUT_DMG}
output=${2:?Missing output DMG}
root=$(cd "$(dirname "$0")/../.." && pwd)
stage=$(mktemp -d "${TMPDIR:-/tmp}/ai-notetaker-dmg.XXXXXX")
trap 'rm -rf "$stage"' EXIT
ditto "$app" "$stage/AI Notetaker.app"
bash "$root/packaging/macos/sign-app.sh" "$stage/AI Notetaker.app"
cp "$root/packaging/macos/install.command" "$stage/Install AI Notetaker.command"
chmod 755 "$stage/Install AI Notetaker.command"
cat >"$stage/START HERE.txt" <<'EOF'
AI Notetaker for Mac

1. Double-click Install AI Notetaker.command. A Terminal window opens.
   Choose Install in the confirmation dialog.
2. The installer copies the app, connects it to Chrome, and opens it.
3. Return to the extension and choose Check desktop helper.

This free release is not notarized by Apple. The installer verifies the app's
bundle integrity and asks before approving this app only. It does not change
Gatekeeper settings or install an audio driver. Only run it from our official
release: https://github.com/apercallc/ai-notetaker/releases/latest

If macOS blocks the installer itself, choose System Settings > Privacy & Security
> Open Anyway, if offered. Managed Macs may require administrator approval.
EOF
mkdir -p "$(dirname "$output")"
hdiutil create -volname "AI Notetaker" -srcfolder "$stage" -ov -format UDZO "$output"
echo "Built ad-hoc signed, non-notarized installer: $output"
