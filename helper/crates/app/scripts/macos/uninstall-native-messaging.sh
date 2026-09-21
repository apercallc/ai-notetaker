#!/bin/sh
set -eu

app_path=${1:-/Applications/AI Notetaker.app}
host_name='com.ainotetaker.helper'
extension_id='jidooookkdbbbhkkdmcajnnnhhphodok'

if [ "${app_path#/}" = "$app_path" ]; then
    app_path=$(cd "$app_path" && pwd -P)
fi

host_binary="$app_path/Contents/MacOS/notetaker-nm-host"
manifest_path="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/$host_name.json"

if [ -f "$manifest_path" ] &&
    grep -Fq "chrome-extension://$extension_id/" "$manifest_path" &&
    grep -Fq "\"path\": \"$host_binary\"" "$manifest_path"; then
    rm -f "$manifest_path"
fi
