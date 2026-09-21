!include "LogicLib.nsh"

!macro NSIS_HOOK_POSTINSTALL
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\windows\install-native-messaging.ps1" -InstallDir "$INSTDIR"' $0
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "AI Notetaker could not register Chrome Native Messaging. The extension will continue to show the helper as unavailable until registration is repaired."
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\windows\uninstall-native-messaging.ps1" -InstallDir "$INSTDIR"' $0
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "AI Notetaker could not remove its Chrome Native Messaging registration. If Chrome still lists the helper after uninstall, remove the per-user registration documented in the uninstall guide."
  ${EndIf}
!macroend
