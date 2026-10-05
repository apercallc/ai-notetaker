#!/bin/bash
# Explicit, app-scoped installation of our non-notarized release. Never change
# Gatekeeper settings or other apps' quarantine attributes.
set -euo pipefail
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH

# Finder can launch the installer more than once before the first confirmation
# dialog is answered. Hold one per-user lock across the entire install,
# including that dialog, so stale approvals cannot race to replace the app.
if [[ "${1:-}" == "--_installer-lock-held" ]]; then
  shift
else
  lock_directory="${TMPDIR:-/tmp}"
  [[ -d "$lock_directory" && ! -L "$lock_directory" ]] || {
    echo "The temporary folder is unavailable. Restart the installer and try again." >&2
    exit 1
  }
  if /usr/bin/lockf -t 0 "$lock_directory/com.ainotetaker.install.lock" \
    /bin/bash "$0" --_installer-lock-held "$@"; then
    exit 0
  else
    lock_status=$?
    if [[ "$lock_status" == 75 ]]; then
      echo "Another AI Notetaker installation is already running. Finish or cancel it, then try again." >&2
    fi
    exit "$lock_status"
  fi
fi

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
ensure_app_stopped() {
  local app_executable="$target/Contents/MacOS/notetaker-helper"
  local pid process_command
  while IFS= read -r pid; do
    process_command=$(ps -p "$pid" -o command= 2>/dev/null || true)
    case "$process_command" in
      "$app_executable"|"$app_executable "*)
        fail "Quit AI Notetaker after any recording finishes, then run the installer again."
        ;;
    esac
  done < <(pgrep -x notetaker-helper || true)
}
[[ $(uname -s) == Darwin ]] || fail "This installer requires macOS."
[[ "$destination" == /* ]] || fail "Choose an absolute Applications folder."
[[ ! -L "$source_app" ]] || fail "The source app must not be a symbolic link."
identifier=$(plutil -extract CFBundleIdentifier raw -o - "$source_app/Contents/Info.plist")
[[ "$identifier" == com.ainotetaker.helper ]] || fail "This is not the AI Notetaker app."
codesign --verify --deep --strict "$source_app" || fail "The app failed its integrity check. Download a fresh installer from the official release."
target="$destination/AI Notetaker.app"
[[ ! -L "$destination" && ! -L "$target" ]] || fail "The installation folder and app must not be symbolic links."
if [[ -e "$target" ]]; then
  existing_id=$(plutil -extract CFBundleIdentifier raw -o - "$target/Contents/Info.plist")
  [[ "$existing_id" == com.ainotetaker.helper ]] || fail "Another app already uses this name. Nothing was replaced."
fi
ensure_app_stopped
if [[ "$approved" == 0 ]]; then
  osascript -e 'display dialog "Apple has not notarized this free release, so this installer asks you to confirm it. Continue only if you downloaded it from the official AI Notetaker release. Choosing Install copies and opens AI Notetaker. Other Mac security settings stay unchanged." with title "Install AI Notetaker" buttons {"Cancel", "Install"} default button "Install" cancel button "Cancel"' >/dev/null
fi
# The app may have started while the installer waited for confirmation.
ensure_app_stopped
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

echo "Copying and verifying AI Notetaker…"
ditto "$source_app" "$stage/AI Notetaker.app"
codesign --verify --deep --strict "$stage/AI Notetaker.app"
# The user explicitly approved this unsigned release. Clear only the download
# quarantine on the validated copy, never system-wide policy or all xattrs.
xattr -dr com.apple.quarantine "$stage/AI Notetaker.app"
codesign --verify --deep --strict "$stage/AI Notetaker.app"
ensure_app_stopped
echo "Installing AI Notetaker…"
if [[ -e "$target" ]]; then mv "$target" "$stage/previous.app"; fi
mv "$stage/AI Notetaker.app" "$target"
committed=1

# Native Messaging only serves users who still use the legacy extension. A
# missing or failing browser hook must never block the standalone desktop app.
legacy_hook="$target/Contents/Resources/scripts/install-native-messaging.sh"
if [[ -x "$target/Contents/MacOS/notetaker-nm-host" && -f "$legacy_hook" ]]; then
  echo "Setting up optional support for existing extension users…"
  if ! sh "$legacy_hook" "$target"; then
    echo "The desktop app is installed. Optional browser support was not set up; desktop recording works without it." >&2
  fi
fi
if [[ "$launch" == 1 ]]; then
  echo "Opening AI Notetaker…"
  open "$target" || fail "Installed. Open AI Notetaker from Applications to finish setup."
fi
echo "AI Notetaker desktop app is installed. Add your provider API keys in Settings, then use Start notes from Record."
