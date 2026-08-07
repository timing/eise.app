!macro customInit
  ; Force-terminate any lingering Eise processes before install/update.
  ; Works around NSIS "app cannot be closed" false positives caused by
  ; stale process handles or aborted prior installs.
  nsExec::Exec 'taskkill /F /IM "Eise.exe" /T'
!macroend
