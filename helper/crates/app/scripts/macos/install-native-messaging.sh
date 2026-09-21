#!/bin/sh
set -eu

app_path=${1:-/Applications/AI Notetaker.app}
host_name='com.ainotetaker.helper'
extension_id='jidooookkdbbbhkkdmcajnnnhhphodok'

if [ "${app_path#/}" = "$app_path" ]; then
    app_path=$(cd "$app_path" && pwd -P)
fi

host_binary="$app_path/Contents/MacOS/notetaker-nm-host"
manifest_dir="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
manifest_path="$manifest_dir/$host_name.json"

if [ ! -x "$host_binary" ]; then
    echo "Native Messaging host was not found or is not executable: $host_binary" >&2
    exit 1
fi

if [ -e "$manifest_path" ] && {
    ! grep -Fq "chrome-extension://$extension_id/" "$manifest_path" ||
    ! grep -Fq "\"path\": \"$host_binary\"" "$manifest_path";
}; then
    echo "Refusing to overwrite an unrelated Native Messaging manifest: $manifest_path" >&2
    exit 1
fi

umask 022
mkdir -p "$manifest_dir"
temporary_path=$(mktemp "$manifest_dir/.$host_name.json.XXXXXX")
trap 'rm -f "$temporary_path"' EXIT HUP INT TERM
printf '%s\n' "{\"name\":\"$host_name\",\"description\":\"AI Notetaker desktop helper Native Messaging relay\",\"path\":\"$host_binary\",\"type\":\"stdio\",\"allowed_origins\":[\"chrome-extension://$extension_id/\"]}" > "$temporary_path"
chmod 644 "$temporary_path"
mv -f "$temporary_path" "$manifest_path"
trap - EXIT HUP INT TERM
