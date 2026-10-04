# Shared migration fixtures

`desktop-audio-transfer-v1.b64` contains a small deterministic archive emitted
by the legacy extension exporter and consumed by the desktop Rust importer.
Base64 keeps the binary fixture importable from the extension test without
filesystem APIs. The extension test decodes and compares its complete output
byte-for-byte; the Rust test decodes and imports the same fixture, then checks
note text, action items, audio channels, byte counts, and idempotency. This
protects the compatibility boundary while the legacy extension remains
available for data migration.
