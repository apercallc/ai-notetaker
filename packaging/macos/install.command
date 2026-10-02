#!/bin/bash
# Explicit, app-scoped installation of our non-notarized release. Never change
# Gatekeeper settings or other apps' quarantine attributes.
set -euo pipefail
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH

here=$(cd "$(dirname "$0")" && pwd -P)
source_app="$here/AI Notetaker.app"
destination="${HOME:?Home folder is unavailable}/Applications"
approved=0
launch=1
while [[ $# -gt 0 ]]; do
  case "$1" in
  --destination)
    destination=${2:?Missing destination}
    shift 2
    ;;
  --allow-unnotarized)
    approved=1
    shift
    ;;
  --no-open)
    launch=0
    shift
    ;;
  *)
    echo "Unknown option: $1" >&2
    exit 1
    ;;
  esac
done

fail() {
  echo "$*" >&2
  exit 1
}
[[ $(uname -s) == Darwin ]] || fail "This installer requires macOS."
[[ "$destination" == /* ]] || fail "Choose an absolute Applications folder."
[[ ! -L "$source_app" ]] || fail "The source app must not be a symbolic link."
identifier=$(plutil -extract CFBundleIdentifier raw -o - "$source_app/Contents/Info.plist")
[[ "$identifier" == com.ainotetaker.helper ]] || fail "This is not the AI Notetaker app."
codesign --verify --deep --strict "$source_app" || fail "The app failed its integrity check. Download a fresh installer from the official release."
[[ -x "$source_app/Contents/MacOS/notetaker-nm-host" ]] || fail "Browser connection component is missing."
[[ -f "$source_app/Contents/Resources/scripts/install-native-messaging.sh" ]] || fail "Browser setup script is missing."

target="$destination/AI Notetaker.app"
[[ ! -L "$destination" && ! -L "$target" ]] || fail "The installation folder and app must not be symbolic links."
if [[ -e "$target" ]]; then
  existing_id=$(plutil -extract CFBundleIdentifier raw -o - "$target/Contents/Info.plist")
  [[ "$existing_id" == com.ainotetaker.helper ]] || fail "Another app already uses this name. Nothing was replaced."
fi
if pgrep -x notetaker-helper >/dev/null; then
  fail "Quit AI Notetaker from its menu bar icon after any recording finishes, then run the installer again."
fi
if [[ "$approved" == 0 ]]; then
  osascript -e 'display dialog "Install AI Notetaker? This release is not notarized by Apple. Continue only if you downloaded it from the official AI Notetaker release. Installation approves this app only, connects it to your browser, and opens it. Your other Mac security settings stay unchanged." with title "Install AI Notetaker" buttons {"Cancel", "Install"} default button "Install" cancel button "Cancel"' >/dev/null
fi
mkdir -p "$destination"
[[ -w "$destination" ]] || fail "This folder is not writable. Ask your Mac administrator to install AI Notetaker."
stage=$(mktemp -d "$destination/.ai-notetaker-install.XXXXXX")
committed=0
cleanup() {
  if [[ "$committed" == 0 && -d "$stage/previous.app" ]]; then
    if [[ -e "$target" ]] || ! mv "$stage/previous.app" "$target"; then
      echo "Previous app preserved at $stage/previous.app" >&2
      return
    fi
  fi
  rm -rf "$stage"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

ditto "$source_app" "$stage/AI Notetaker.app"
codesign --verify --deep --strict "$stage/AI Notetaker.app"
# The user explicitly approved this unsigned release. Clear only the download
# quarantine on the validated copy, never system-wide policy or all xattrs.
xattr -dr com.apple.quarantine "$stage/AI Notetaker.app"
codesign --verify --deep --strict "$stage/AI Notetaker.app"
if [[ -e "$target" ]]; then mv "$target" "$stage/previous.app"; fi
mv "$stage/AI Notetaker.app" "$target"
committed=1

# Keep a successfully installed app if registration or launch fails. Retrying
# installation can repair registration; deleting the app would leave dangling
# manifests and turn a recoverable setup problem into a broken installation.
sh "$target/Contents/Resources/scripts/install-native-messaging.sh" "$target" || fail "The app is installed, but browser setup failed. Run this installer again to reconnect it."
if [[ "$launch" == 1 ]]; then
  open "$target" || fail "Installed. Open AI Notetaker from Applications to finish setup."
fi
echo "AI Notetaker is installed. Look for its menu bar icon, then return to Chrome and choose Check desktop helper."
