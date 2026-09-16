; nsis-installer.nsh - NSIS hooks for the omnicross desktop installer.
;
; WHY THIS EXISTS: upgrading over a running install failed at the FIRST step
; (the previous version's uninstaller). The old uninstaller only knows how to
; close the main app exe; the previous version's bundled daemon (node.exe)
; survives as an orphan (versions before the job-object fix, an adopted
; daemon, or a crashed app) and holds daemon-runtime files locked, so file
; deletion/replacement dies. Tauri's NSIS_HOOK_PREINSTALL runs inside the
; install SECTION - AFTER the reinstall page has already executed the old
; uninstaller - so it cannot help that step. We therefore kill at PAGE time:
; this file is !included before the template's page declarations, so our
; invisible custom page runs FIRST, before the reinstall page can launch the
; old uninstaller.
;
; WHAT WE KILL - and only this - are processes whose executable PATH lies
; under $INSTDIR (the app exe, the bundled node daemon, anything else shipped
; in the install dir). Never by image name: per this project's incident
; history, `taskkill /IM node.exe` murders other applications' node
; processes. The PowerShell one-liner deliberately uses the comparison
; statement syntax (`Where-Object Path -Like '...'`) - no script blocks, no
; `$_` - so the NSIS compiler can never misread a `$` token.
;
; Hooks used:
;   - the invisible first page (interactive + passive installs; covers the
;     old-uninstaller step that runs at reinstall-page time)
;   - NSIS_HOOK_PREINSTALL (silent installs: pages never run, but the install
;     section still copies files that the same lock would break)
;   - NSIS_HOOK_PREUNINSTALL (this build's own uninstaller; the next upgrade
;     over THIS version is covered natively)

!macro OMNICROSS_KILL_FROM_INSTALL_DIR UN
Function ${UN}KillProcessesFromInstallDir
  ${If} "$INSTDIR" != ""
    DetailPrint "omnicross: stopping processes running from $INSTDIR"
    ; Force-stop everything executing from the install directory (app, bundled
    ; node daemon, its workers). Best-effort: a PowerShell failure must never
    ; abort the install - the template's own checks still guard the app exe.
    nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-Process | Where-Object Path -Like $\'>$INSTDIR*$\' | Stop-Process -Force"'
    Pop $0
    ; Handles need a beat to be released after the kernel tears the processes
    ; down; a second sweep catches anything still mid-exit.
    Sleep 700
    nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-Process | Where-Object Path -Like $\'>$INSTDIR*$\' | Stop-Process -Force"'
    Pop $0
  ${EndIf}
FunctionEnd
!macroend

!insertmacro OMNICROSS_KILL_FROM_INSTALL_DIR ""
!insertmacro OMNICROSS_KILL_FROM_INSTALL_DIR "un."

; The invisible first page: its creator runs the kill, then Abort skips the
; page itself (the classic NSIS run-code-at-page-time idiom). Declared here -
; before the template's own Page/MUI_PAGE lines, since this file is included
; first - so it executes before the reinstall page can launch the old
; uninstaller.
;
; Guarded by the previous-install registry key: a FRESH install has no old
; uninstaller step to protect, so it should not kill a running app before the
; user has even confirmed anything (the PREINSTALL hook still covers the
; file-copy lock on every path).
Page custom OmnicrossKillPage
Function OmnicrossKillPage
  ReadRegStr $0 SHCTX "${UNINSTKEY}" "UninstallString"
  ${If} "$0" != ""
    Call KillProcessesFromInstallDir
  ${EndIf}
  Abort
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  ; Silent installs skip every page (our kill page included); the install
  ; section still lands on the same locked files, so kill here too. Harmless
  ; no-op when the page already did it.
  Call KillProcessesFromInstallDir
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; This build's own uninstaller: stop the daemon before deleting files (the
  ; job object usually handles it on app exit - this covers orphans, adopted
  ; daemons, and crashed-app leftovers).
  Call un.KillProcessesFromInstallDir
!macroend
