#!/bin/sh
set -eu

app_path=${1:-/Applications/AI Notetaker.app}
host_name='com.ainotetaker.helper'
extension_id='jidooookkdbbbhkkdmcajnnnhhphodok'

if [ "${app_path#/}" = "$app_path" ]; then
    app_path=$(cd "$app_path" && pwd -P)
fi

host_binary="$app_path/Contents/MacOS/notetaker-nm-host"

uninstall_for_vendor() {
    vendor_dir=$1
    manifest_path="$HOME/Library/Application Support/$vendor_dir/NativeMessagingHosts/$host_name.json"

    if [ -f "$manifest_path" ] &&
        grep -Fq "chrome-extension://$extension_id/" "$manifest_path" &&
        grep -Fq "\"path\":\"$host_binary\"" "$manifest_path"; then
        rm -f "$manifest_path"
    fi
}

for vendor_dir in "Google/Chrome" "Microsoft Edge" "BraveSoftware/Brave-Browser"; do
    uninstall_for_vendor "$vendor_dir"
done

gecko_id='notetaker@apercallc.dev'
firefox_manifest_path="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts/$host_name.json"
if [ -f "$firefox_manifest_path" ] &&
    grep -Fq "\"$gecko_id\"" "$firefox_manifest_path" &&
    grep -Fq "\"path\":\"$host_binary\"" "$firefox_manifest_path"; then
    rm -f "$firefox_manifest_path"
fi
