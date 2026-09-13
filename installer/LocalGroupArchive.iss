#define MyAppName "LocalGroupArchive"
#ifndef AppVersion
  #define AppVersion "0.9.2"
#endif
#define MyAppVersion AppVersion
#define MyAppPublisher "Faisal"
#ifndef Repository
  #define Repository "OWNER/LocalGroupArchive"
#endif

[Setup]
AppId={{4A6F87E3-91D2-4A16-9DC2-55D55C6B7A91}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\LocalGroupArchive Installer
DefaultGroupName=LocalGroupArchive
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible arm64
ArchitecturesInstallIn64BitMode=x64compatible arm64
WizardStyle=modern
Compression=lzma2/ultra64
SolidCompression=yes
OutputDir=..\dist
OutputBaseFilename=LocalGroupArchive-Setup-v{#MyAppVersion}
SetupLogging=yes
CloseApplications=no
UninstallDisplayName=LocalGroupArchive (keeps local archives)
LicenseFile=..\LICENSE

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "Install-LocalGroupArchive.ps1"; DestDir: "{app}\installer"; Flags: ignoreversion
Source: "Update-LocalGroupArchive.ps1"; DestDir: "{app}\installer"; Flags: ignoreversion
Source: "Remove-LocalGroupArchive.ps1"; DestDir: "{app}\installer"; Flags: ignoreversion
Source: "..\plugin\*"; DestDir: "{app}\plugin"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\CHANGELOG.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\SECURITY.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Repair LocalGroupArchive"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoLogo -NoProfile -ExecutionPolicy Bypass -File ""{app}\installer\Install-LocalGroupArchive.ps1"" -Action Repair -PayloadRoot ""{app}\plugin"" -Repository ""{#Repository}"""; WorkingDir: "{app}"
Name: "{group}\Check for updates"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoLogo -NoProfile -ExecutionPolicy Bypass -File ""{app}\installer\Update-LocalGroupArchive.ps1"" -Repository ""{#Repository}"" -CurrentVersion ""{#MyAppVersion}"""; WorkingDir: "{app}"
Name: "{group}\Open local archive"; Filename: "{userdocs}\Discord Local Archive.html"

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoLogo -NoProfile -ExecutionPolicy Bypass -File ""{app}\installer\Remove-LocalGroupArchive.ps1"""; Flags: runascurrentuser waituntilterminated; RunOnceId: "RemoveLocalGroupArchivePlugin"

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  Params: String;
  ResultPath: String;
  ResultText: AnsiString;
begin
  if CurStep = ssPostInstall then
  begin
    ResultPath := ExpandConstant('{tmp}\LocalGroupArchive-install-result.txt');
    DeleteFile(ResultPath);
    WizardForm.StatusLabel.Caption := 'Installing and validating developer Vencord...';
    Params := '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' +
      ExpandConstant('{app}\installer\Install-LocalGroupArchive.ps1') +
      '" -Action Install -PayloadRoot "' + ExpandConstant('{app}\plugin') +
      '" -Repository "{#Repository}" -ResultFile "' + ResultPath + '"';
    if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
      Params, ExpandConstant('{app}'), SW_SHOWNORMAL, ewWaitUntilTerminated, ResultCode) then
      RaiseException('Could not start the LocalGroupArchive setup script.');
    if ResultCode <> 0 then
    begin
      if LoadStringFromFile(ResultPath, ResultText) then
        RaiseException('LocalGroupArchive setup failed.' + #13#10 + #13#10 + String(ResultText))
      else
        RaiseException('LocalGroupArchive setup failed before diagnostics were written.' + #13#10 +
          'Logs: ' + ExpandConstant('{localappdata}\LocalGroupArchive\logs'));
    end;
  end;
end;
