# Vendored security backports

`glib-0.18.5/` is the upstream GLib Rust binding release used by the stable
Tauri 2 GTK 3 stack. Tauri 2.11.6 still requires the `0.18` API, while the
upstream fix for `VariantStrIter::impl_get` was first released in GLib 0.20.

The upstream fix in `src/variant_iter.rs` makes the child-string pointer
mutable and passes it as `&mut p`, correcting the out-parameter handling. It
is backported from gtk-rs-core pull request 1343. Keep this patch until the
stable Tauri Linux dependency chain moves to a fixed GLib release; then
remove the vendor directory and the workspace patch in `Cargo.toml`.

The original GLib MIT license and copyright notice are retained in this
directory.
