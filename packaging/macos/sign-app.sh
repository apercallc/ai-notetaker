#!/bin/bash
# A complete ad-hoc seal fixes linker-only signatures. This is not Developer ID
# signing or notarization and deliberately makes no publisher-trust claim.
set -euo pipefail

app=${1:?Usage: sign-app.sh APP_PATH}
root=$(cd "$(dirname "$0")/../.." && pwd)
identifier=$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$app/Contents/Info.plist")
[[ "$identifier" == com.ainotetaker.helper ]] || {
  echo "Unexpected app identifier" >&2
  exit 1
}
[[ ! -L "$app" && -x "$app/Contents/MacOS/notetaker-helper" ]] || exit 1

# Sign nested Mach-O code before the outer bundle. Do not use --deep to sign:
# it can hide missing or incorrectly placed nested components.
while IFS= read -r -d '' file; do
  [[ "$file" == "$app/Contents/MacOS/notetaker-helper" ]] && continue
  if /usr/bin/file -b "$file" | /usr/bin/grep -q 'Mach-O'; then
    /usr/bin/codesign --force --sign - "$file"
  fi
done < <(/usr/bin/find "$app/Contents" -type f -print0)
/usr/bin/codesign --force --sign - --entitlements "$root/helper/crates/app/Entitlements.plist" "$app"
/usr/bin/codesign --verify --deep --strict --verbose=2 "$app"
