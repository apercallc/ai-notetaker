# Windows VB-CABLE release staging

The Windows helper bundle may include only the base VB-CABLE package. The
release workflow downloads the official archive, verifies the release-owner
supplied `VB_CABLE_SHA256` repository variable, extracts the complete archive,
and stages it under `helper/crates/app/resources/windows/vb-cable/`.

The payload is intentionally not committed. A Windows helper release must not
run unless that checksum is configured. The helper launches
`VBCABLE_Setup_x64.exe` visibly so the user can approve the administrator
prompt; it does not fetch or execute a driver at runtime.

VB-Audio's official flow is to extract the archive, run the x64 setup as
administrator, and reboot when requested. The installer UI must retain
attribution to [VB-Audio](https://vb-audio.com/Cable/) and the donation option.
Never stage the A+B/C+D variants.
