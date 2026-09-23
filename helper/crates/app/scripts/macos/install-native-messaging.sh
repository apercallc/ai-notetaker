#!/bin/sh
set -eu

app_path=${1:-/Applications/AI Notetaker.app}
host_name='com.ainotetaker.helper'
extension_id='jidooookkdbbbhkkdmcajnnnhhphodok'

if [ "${app_path#/}" = "$app_path" ]; then
    app_path=$(cd "$app_path" && pwd -P)
fi

host_binary="$app_path/Contents/MacOS/notetaker-nm-host"

if [ ! -x "$host_binary" ]; then
    echo "Native Messaging host was not found or is not executable: $host_binary" >&2
    exit 1
fi

install_for_vendor() {
    vendor_dir=$1
    manifest_dir="$HOME/Library/Application Support/$vendor_dir/NativeMessagingHosts"
    manifest_path="$manifest_dir/$host_name.json"

    if [ -e "$manifest_path" ] && {
        ! grep -Fq "chrome-extension://$extension_id/" "$manifest_path" ||
        ! grep -Fq "\"path\":\"$host_binary\"" "$manifest_path";
    }; then
        echo "Refusing to overwrite an unrelated Native Messaging manifest: $manifest_path" >&2
        return 1
    fi

    umask 022
    mkdir -p "$manifest_dir"
    temporary_path=$(mktemp "$manifest_dir/.$host_name.json.XXXXXX")
    trap 'rm -f "$temporary_path"' EXIT HUP INT TERM
    printf '%s\n' "{\"name\":\"$host_name\",\"description\":\"AI Notetaker desktop helper Native Messaging relay\",\"path\":\"$host_binary\",\"type\":\"stdio\",\"allowed_origins\":[\"chrome-extension://$extension_id/\"]}" > "$temporary_path"
    chmod 644 "$temporary_path"
    mv -f "$temporary_path" "$manifest_path"
    trap - EXIT HUP INT TERM
}

for vendor_dir in "Google/Chrome" "Microsoft Edge" "BraveSoftware/Brave-Browser"; do
    install_for_vendor "$vendor_dir"
done

# Firefox uses a structurally different manifest shape (allowed_extensions
# with a gecko ID, not allowed_origins with a chrome-extension:// URL) and
# its own directory, so it can't reuse install_for_vendor above.
install_firefox() {
    gecko_id='notetaker@apercallc.dev'
    manifest_dir="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
    manifest_path="$manifest_dir/$host_name.json"

    if [ -e "$manifest_path" ] && {
        ! grep -Fq "\"$gecko_id\"" "$manifest_path" ||
        ! grep -Fq "\"path\":\"$host_binary\"" "$manifest_path";
    }; then
        echo "Refusing to overwrite an unrelated Native Messaging manifest: $manifest_path" >&2
        return 1
    fi

    umask 022
    mkdir -p "$manifest_dir"
    temporary_path=$(mktemp "$manifest_dir/.$host_name.json.XXXXXX")
    trap 'rm -f "$temporary_path"' EXIT HUP INT TERM
    printf '%s\n' "{\"name\":\"$host_name\",\"description\":\"AI Notetaker desktop helper Native Messaging relay\",\"path\":\"$host_binary\",\"type\":\"stdio\",\"allowed_extensions\":[\"$gecko_id\"]}" > "$temporary_path"
    chmod 644 "$temporary_path"
    mv -f "$temporary_path" "$manifest_path"
    trap - EXIT HUP INT TERM
}

install_firefox
