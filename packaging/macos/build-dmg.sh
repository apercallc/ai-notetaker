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

This free release is not notarized by Apple, so macOS asks you to approve it
once. Only run it from our official release:
https://github.com/apercallc/ai-notetaker/releases/latest

1. Double-click Install AI Notetaker.command.
2. macOS blocks it the first time. The dialog says "Not Opened" and offers only
   Cancel and Move to Trash. Click Cancel. Do NOT click Move to Trash.
3. Open System Settings > Privacy & Security and scroll to Security.
4. Next to "Install AI Notetaker.command" choose Open Anyway, enter your Mac
   password, and choose Open.
5. Double-click Install AI Notetaker.command again and choose Install in the
   confirmation dialog. It copies the app to Applications and opens it. If
   macOS blocks the app itself, repeat steps 3-4 for AI Notetaker.
6. In Settings, add and test your provider API keys. Then open Record and
   choose Start notes. No browser extension or AI Notetaker account is needed.

The installer verifies the app's bundle integrity and asks before approving
this app only. It does not change Gatekeeper settings or install an audio
driver. No Terminal commands are needed. If you drag AI Notetaker to
Applications yourself instead, approve the app the same way (steps 3-4).
Managed Macs may require administrator approval.

Existing extension users may keep using their browser connection during
migration. New desktop users do not need Chrome or Native Messaging.

EOF
mkdir -p "$(dirname "$output")"
hdiutil create -volname "AI Notetaker" -srcfolder "$stage" -ov -format UDZO "$output"
echo "Built ad-hoc signed, non-notarized installer: $output"
