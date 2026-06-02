!include "common.nsh"
!include "extractAppPackage.nsh"

# HAPI Desktop custom portable template.
# electron-builder's default portable template deletes the extracted app before
# and after every launch. That makes a large Electron bundle slow every time.
# This template keeps a versioned cache under TEMP and only extracts on the
# first launch for a given app version.

# https://github.com/electron-userland/electron-builder/issues/3972#issuecomment-505171582
CRCCheck off
WindowIcon Off
AutoCloseWindow True
RequestExecutionLevel ${REQUEST_EXECUTION_LEVEL}

Var HapiCacheReady

Function .onInit
  StrCpy $HapiCacheReady "0"

  !ifdef UNPACK_DIR_NAME
    StrCpy $INSTDIR "$TEMP\${UNPACK_DIR_NAME}"
    IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 cacheChecked
    IfFileExists "$INSTDIR\.portable-version" 0 cacheChecked
    FileOpen $1 "$INSTDIR\.portable-version" r
    FileRead $1 $2
    FileClose $1
    StrCmp $2 "${VERSION}" 0 cacheChecked
    StrCpy $HapiCacheReady "1"
    SetSilent silent
  !endif

  cacheChecked:
  !ifndef SPLASH_IMAGE
    SetSilent silent
  !endif

  !insertmacro check64BitAndSetRegView
FunctionEnd

Function .onGUIInit
  InitPluginsDir

  !ifdef SPLASH_IMAGE
    StrCmp $HapiCacheReady "1" doneSplash
    File /oname=$PLUGINSDIR\splash.bmp "${SPLASH_IMAGE}"
    BgImage::SetBg $PLUGINSDIR\splash.bmp
    BgImage::Redraw
    doneSplash:
  !endif
FunctionEnd

Section
  !ifdef SPLASH_IMAGE
    HideWindow
  !endif

  StrCpy $INSTDIR "$PLUGINSDIR\app"
  !ifdef UNPACK_DIR_NAME
    StrCpy $INSTDIR "$TEMP\${UNPACK_DIR_NAME}"
  !endif

  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 doExtract
  IfFileExists "$INSTDIR\.portable-version" 0 doExtract
  FileOpen $1 "$INSTDIR\.portable-version" r
  FileRead $1 $2
  FileClose $1
  StrCmp $2 "${VERSION}" launchApp doExtract

  doExtract:
    RMDir /r "$INSTDIR"
    SetOutPath "$INSTDIR"

    !ifdef APP_DIR_64
      !ifdef APP_DIR_ARM64
        !ifdef APP_DIR_32
          ${if} ${IsNativeARM64}
            File /r "${APP_DIR_ARM64}\*.*"
          ${elseif} ${RunningX64}
            File /r "${APP_DIR_64}\*.*"
          ${else}
            File /r "${APP_DIR_32}\*.*"
          ${endIf}
        !else
          ${if} ${IsNativeARM64}
            File /r "${APP_DIR_ARM64}\*.*"
          ${else}
            File /r "${APP_DIR_64}\*.*"
          ${endIf}
        !endif
      !else
        !ifdef APP_DIR_32
          ${if} ${RunningX64}
            File /r "${APP_DIR_64}\*.*"
          ${else}
            File /r "${APP_DIR_32}\*.*"
          ${endIf}
        !else
          File /r "${APP_DIR_64}\*.*"
        !endif
      !endif
    !else
      !ifdef APP_DIR_32
        File /r "${APP_DIR_32}\*.*"
      !else
        !insertmacro extractEmbeddedAppPackage
      !endif
    !endif

    FileOpen $1 "$INSTDIR\.portable-version" w
    FileWrite $1 "${VERSION}"
    FileClose $1

  launchApp:
    System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_DIR", "$EXEDIR").r0'
    System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_FILE", "$EXEPATH").r0'
    System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_APP_FILENAME", "${APP_FILENAME}").r0'
    ${StdUtils.GetAllParameters} $R0 0

    !ifdef SPLASH_IMAGE
      BgImage::Destroy
    !endif

    ExecWait "$INSTDIR\${APP_EXECUTABLE_FILENAME} $R0" $0
    SetErrorLevel $0

    SetOutPath $EXEDIR
SectionEnd
