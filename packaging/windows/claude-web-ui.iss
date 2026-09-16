; Inno Setup script for Claude Code Web UI.
;
; Input is a staged tree from scripts/package.js (--target win32-x64); this only
; wraps it. Build with:
;   iscc /DStageDir=..\..\dist-pkg\win32-x64 /DAppVersion=2.0.0 claude-web-ui.iss
;
; Deliberately a PER-USER install (PrivilegesRequired=lowest, installed under
; %LOCALAPPDATA%\Programs): no UAC prompt, and the app ends up somewhere the
; user can actually write. The app runs as the signed-in user, spawns Claude as
; them and reads their ~/.claude, so a machine-wide install would buy nothing
; and cost an elevation prompt.

#ifndef StageDir
  #define StageDir "..\..\dist-pkg\win32-x64"
#endif
#ifndef AppVersion
  #define AppVersion "2.0.0"
#endif

#define AppName "Claude Code Web UI"
#define AppExeName "Start Claude Web (Background).vbs"

[Setup]
AppId={{8F3C2A71-5D4E-4B9A-9C21-6E7A0B4D1F35}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=amrin78
AppPublisherURL=https://github.com/amrin78-smb/claude-web-ui
DefaultDirName={autopf}\Claude Web UI
DefaultGroupName=Claude Web UI
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=..\..\dist-pkg
OutputBaseFilename=claude-web-ui-{#AppVersion}-setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName={#AppName}
; Refuse to install over a running copy rather than leaving half-replaced files.
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"
Name: "startup"; Description: "Start automatically when I sign in"; GroupDescription: "Startup:"; Flags: unchecked

[Files]
; The whole staged tree: server/, web/dist/, node_modules/, launchers, marker.
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Claude Web UI"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"
Name: "{group}\Stop Claude Web"; Filename: "{app}\Stop Claude Web.bat"; WorkingDir: "{app}"
Name: "{autodesktop}\Claude Web UI"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon
Name: "{userstartup}\Claude Web UI"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; Tasks: startup

[Run]
Filename: "{app}\{#AppExeName}"; Description: "Start Claude Web UI now"; Flags: postinstall nowait shellexec skipifsilent
Filename: "http://127.0.0.1:4280"; Description: "Open it in the browser"; Flags: postinstall nowait shellexec skipifsilent unchecked

[UninstallRun]
; Stop the server before removing files, so uninstall doesn't leave a process
; holding port 4280 (and the install directory locked).
Filename: "{cmd}"; Parameters: "/c ""{app}\Stop Claude Web.bat"""; Flags: runhidden; RunOnceId: "StopServer"

[Code]
// Node is a runtime dependency, not something this installer bundles. Say so
// clearly at install time rather than letting the app fail to start later.
function NodeOnPath(): Boolean;
var
  ResultCode: Integer;
begin
  Result := Exec('cmd.exe', '/c where node >nul 2>nul', '', SW_HIDE,
                 ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
end;

function InitializeSetup(): Boolean;
begin
  Result := True;
  if not NodeOnPath() then
  begin
    if MsgBox('Node.js was not found on this PC.'#13#10#13#10 +
              'Claude Web UI needs Node.js 18 or newer to run. You can install ' +
              'it from https://nodejs.org and then start the app.'#13#10#13#10 +
              'Continue with the installation anyway?',
              mbConfirmation, MB_YESNO) = IDNO then
      Result := False;
  end;
end;
