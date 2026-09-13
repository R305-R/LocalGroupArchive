#Requires -Version 5.1
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$ManagedRoot = Join-Path $env:LOCALAPPDATA "LocalGroupArchive"
$VencordRoot = Join-Path $ManagedRoot "Vencord"
$BackupRoot = Join-Path $env:LOCALAPPDATA ("LocalGroupArchiveUserPluginsBackup\" + (Get-Date -Format "yyyyMMdd-HHmmss"))

function Preserve-UnrelatedUserPlugins {
    $userPlugins = Join-Path $VencordRoot "src\userplugins"
    if (!(Test-Path -LiteralPath $userPlugins)) { return }
    $unrelated = @(Get-ChildItem -LiteralPath $userPlugins -Force | Where-Object {
        $_.Name -notin @("LocalGroupArchive", "LocalGroupArchiveSetup")
    })
    if (!$unrelated.Count) { return }

    New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
    foreach ($item in $unrelated) { Copy-Item -LiteralPath $item.FullName -Destination $BackupRoot -Recurse -Force }
    Write-Host "Preserved unrelated userplugins at: $BackupRoot" -ForegroundColor Yellow
}

function Restore-DiscordAppAsar {
    $restored = 0
    foreach ($name in @("Discord", "DiscordPTB", "DiscordCanary", "DiscordDevelopment")) {
        Get-Process -Name $name -ErrorAction SilentlyContinue | Stop-Process -Force
        $base = Join-Path $env:LOCALAPPDATA $name
        if (!(Test-Path -LiteralPath $base)) { continue }

        foreach ($app in @(Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "app-*" })) {
            $resources = Join-Path $app.FullName "resources"
            $appAsar = Join-Path $resources "app.asar"
            $backupAsar = Join-Path $resources "_app.asar"
            if (!(Test-Path -LiteralPath $backupAsar)) { continue }

            Remove-Item -LiteralPath $appAsar -Force -ErrorAction SilentlyContinue
            Move-Item -LiteralPath $backupAsar -Destination $appAsar -Force
            $restored++
        }
    }
    return $restored
}

try {
    Write-Host "Removing LocalGroupArchive and restoring Discord..." -ForegroundColor Cyan
    Preserve-UnrelatedUserPlugins
    $restored = Restore-DiscordAppAsar
    if (Test-Path -LiteralPath $ManagedRoot) { Remove-Item -LiteralPath $ManagedRoot -Recurse -Force }

    Write-Host "LocalGroupArchive's managed Vencord runtime was removed." -ForegroundColor Green
    if ($restored -gt 0) {
        Write-Host "Discord's original app.asar was restored in $restored installation(s)." -ForegroundColor Green
    }
    Write-Host "Documents\DiscordLocalArchive was intentionally kept." -ForegroundColor Green
} catch {
    Write-Host ("Removal needs attention: " + $_.Exception.Message) -ForegroundColor Red
    Write-Host "Your archive data was not touched." -ForegroundColor Yellow
    exit 1
}
