!define MUI_CUSTOMFUNCTION_GUIEND DayloreRefreshShortcutIcons
Var DayloreMainBinaryPath
Var DayloreShortcutIconPath
Var DayloreDesktopShortcut
Var DayloreStartMenuShortcut
Var DayloreNestedStartMenuShortcut

Function DayloreRefreshShortcutIcons
  CreateShortcut "$DayloreDesktopShortcut" "$DayloreMainBinaryPath" "" "$DayloreShortcutIconPath" 0 SW_SHOWNORMAL "" ""
  CreateShortcut "$DayloreStartMenuShortcut" "$DayloreMainBinaryPath" "" "$DayloreShortcutIconPath" 0 SW_SHOWNORMAL "" ""
  ${If} $DayloreNestedStartMenuShortcut != ""
    CreateShortcut "$DayloreNestedStartMenuShortcut" "$DayloreMainBinaryPath" "" "$DayloreShortcutIconPath" 0 SW_SHOWNORMAL "" ""
  ${EndIf}
  System::Call 'shell32::SHChangeNotify(i 0x00002000, i 0x0005, w "$DayloreDesktopShortcut", p 0)'
  System::Call 'shell32::SHChangeNotify(i 0x00002000, i 0x0005, w "$DayloreStartMenuShortcut", p 0)'
  ${If} $DayloreNestedStartMenuShortcut != ""
    System::Call 'shell32::SHChangeNotify(i 0x00002000, i 0x0005, w "$DayloreNestedStartMenuShortcut", p 0)'
  ${EndIf}
FunctionEnd

!macro NSIS_HOOK_POSTINSTALL
  StrCpy $DayloreMainBinaryPath "$INSTDIR\${MAINBINARYNAME}.exe"
  StrCpy $DayloreShortcutIconPath "$INSTDIR\icons\daylore-${VERSION}.ico"
  StrCpy $DayloreDesktopShortcut "$DESKTOP\${PRODUCTNAME}.lnk"
  StrCpy $DayloreStartMenuShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  ${If} $AppStartMenuFolder != ""
    StrCpy $DayloreNestedStartMenuShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
  ${EndIf}
  SetOutPath "$INSTDIR\icons"
  File /oname=daylore-${VERSION}.ico "${INSTALLERICON}"
  SetOutPath "$INSTDIR"
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayIcon" "$INSTDIR\icons\daylore-${VERSION}.ico"
  Call DayloreRefreshShortcutIcons
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Delete "$INSTDIR\icons\daylore-*.ico"
  RMDir "$INSTDIR\icons"
!macroend
