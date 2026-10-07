!include "LogicLib.nsh"

!macro NSIS_HOOK_POSTINSTALL
  ; Tauri 2 installs mapped resources directly under $INSTDIR; older layouts used $INSTDIR\resources.
  StrCpy $1 "$INSTDIR\windows"
  ${IfNot} ${FileExists} "$1\install-native-messaging.ps1"
    StrCpy $1 "$INSTDIR\resources\windows"
  ${EndIf}
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$1\install-native-messaging.ps1" -InstallDir "$INSTDIR"' $0
  ${If} $0 != 0
    ; Browser-extension registration is optional; the desktop app works without it.
    DetailPrint "Optional browser extension link was not registered (exit code $0). AI Notetaker works without it."
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Tauri 2 installs mapped resources directly under $INSTDIR; older layouts used $INSTDIR\resources.
  StrCpy $1 "$INSTDIR\windows"
  ${IfNot} ${FileExists} "$1\uninstall-native-messaging.ps1"
    StrCpy $1 "$INSTDIR\resources\windows"
  ${EndIf}
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$1\uninstall-native-messaging.ps1" -InstallDir "$INSTDIR"' $0
  ${If} $0 != 0
    DetailPrint "Optional browser extension link could not be removed (exit code $0)."
  ${EndIf}
!macroend
