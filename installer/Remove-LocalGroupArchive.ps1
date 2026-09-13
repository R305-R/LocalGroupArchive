#Requires -Version 5.1
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$ManagedRoot = Join-Path $env:LOCALAPPDATA "LocalGroupArchive"
$VencordRoot = Join-Path $ManagedRoot "Vencord"
$Injector = Join-Path $ManagedRoot "tools\VencordInstallerCli.exe"
$BackupRoot = Join-Path $env:LOCALAPPDATA ("LocalGroupArchiveUserPluginsBackup\" + (Get-Date -Format "yyyyMMdd-HHmmss"))

try {
    Write-Host "Removing LocalGroupArchive and restoring regular Vencord..." -ForegroundColor Cyan
    if (!(Test-Path -LiteralPath $ManagedRoot)) {
        Write-Host "The managed build is already gone. The local archive remains untouched." -ForegroundColor Green
        exit 0
    }
    if (!(Test-Path -LiteralPath $Injector)) {
        throw "The verified Vencord CLI is missing. Run Repair from the Start menu, then uninstall again."
    }

    $userPlugins = Join-Path $VencordRoot "src\userplugins"
    if (Test-Path -LiteralPath $userPlugins) {
        $unrelated = @(Get-ChildItem -LiteralPath $userPlugins -Force | Where-Object {
            $_.Name -notin @("LocalGroupArchive", "LocalGroupArchiveSetup")
        })
        if ($unrelated.Count) {
            New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
            foreach ($item in $unrelated) {
                Copy-Item -LiteralPath $item.FullName -Destination $BackupRoot -Recurse -Force
            }
            Write-Host "Preserved unrelated userplugins at: $BackupRoot" -ForegroundColor Yellow
        }
    }

    foreach ($name in @("Discord", "DiscordCanary", "DiscordPTB", "DiscordDevelopment")) {
        Get-Process -Name $name -ErrorAction SilentlyContinue | Stop-Process -Force
    }

    $statePath = Join-Path $ManagedRoot "install-state.json"
    $state = if (Test-Path -LiteralPath $statePath) { Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } else { $null }
    $branch = if ($state -and ([string]$state.discordBranch) -in @("stable", "ptb", "canary")) {
        [string]$state.discordBranch
    } else {
        "auto"
    }

    $oldUserData = $env:VENCORD_USER_DATA_DIR
    $oldDevInstall = $env:VENCORD_DEV_INSTALL
    try {
        $env:VENCORD_USER_DATA_DIR = $null
        $env:VENCORD_DEV_INSTALL = $null
        $global:LASTEXITCODE = 0
        & $Injector --repair --branch $branch
        if ($LASTEXITCODE -ne 0) { throw "Restoring regular Vencord failed with exit code $LASTEXITCODE." }
    } finally {
        $env:VENCORD_USER_DATA_DIR = $oldUserData
        $env:VENCORD_DEV_INSTALL = $oldDevInstall
    }

    Remove-Item -LiteralPath $ManagedRoot -Recurse -Force
    Write-Host "Plugin and managed build tools removed; regular Vencord was restored." -ForegroundColor Green
    Write-Host "Documents\DiscordLocalArchive was intentionally kept." -ForegroundColor Green
} catch {
    Write-Host ("Removal needs attention: " + $_.Exception.Message) -ForegroundColor Red
    Write-Host "Your archive data was not touched." -ForegroundColor Yellow
    exit 1
}
