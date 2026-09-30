# Chrome Web Store listing

The submission copy, permission justifications, data-usage answers, reviewer
notes and step-by-step instructions now live in
[`docs/launch/chrome-web-store.md`](launch/chrome-web-store.md), with the
overall plan in [`docs/launch/README.md`](launch/README.md).

This page used to hold an earlier draft that listed `identity`,
`nativeMessaging` and `alarms` as install-time permissions and omitted
`clipboardWrite`. Those three are optional in `extension/manifest.json`, and
the launch guide reflects the real manifest. When the manifest's permissions
change, update the justifications in the launch guide before submitting.
