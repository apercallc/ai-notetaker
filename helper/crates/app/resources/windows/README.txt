Release-only resource directory

The Windows release workflow stages the complete, checksum-pinned official
base VB-CABLE archive under vb-cable/ before building the Tauri installer.
The archive is intentionally not committed to this repository.

Only the base VB-CABLE package is allowed. Do not add A+B/C+D variants. The
helper launches VBCABLE_Setup_x64.exe visibly so Windows can show its normal
administrator flow; it does not download drivers at runtime.
