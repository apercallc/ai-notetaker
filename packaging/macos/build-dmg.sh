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
2. The installer copies the desktop app to Applications and opens it.
3. In Settings, add and test your provider API keys. Then open Record and
   choose Start notes. No browser extension or AI Notetaker account is needed.

This free release is not notarized by Apple. The installer verifies the app's
bundle integrity and asks before approving this app only. It does not change
Gatekeeper settings or install an audio driver. Only run it from our official
release: https://github.com/apercallc/ai-notetaker/releases/latest

Existing extension users may keep using their browser connection during
migration. New desktop users do not need Chrome or Native Messaging.

macOS asks you to approve this free app once. If it says the installer or app
"cannot be opened" or "could not be verified":
  1. Open System Settings > Privacy & Security.
  2. Scroll to Security and choose Open Anyway next to AI Notetaker.
  3. Enter your Mac password and choose Open.
(On macOS 13 and 14 you can instead Control-click the file and choose Open.)
No Terminal commands are needed. If you drag AI Notetaker to Applications
yourself instead of using the installer, approve it the same way the first time.
Managed Macs may require administrator approval.
EOF
mkdir -p "$(dirname "$output")"
hdiutil create -volname "AI Notetaker" -srcfolder "$stage" -ov -format UDZO "$output"
echo "Built ad-hoc signed, non-notarized installer: $output"
