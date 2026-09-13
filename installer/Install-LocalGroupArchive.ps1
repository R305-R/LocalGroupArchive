#Requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateSet("Install", "Repair")]
    [string]$Action = "Install",
    [string]$PayloadRoot = (Join-Path $PSScriptRoot "..\plugin"),
    [string]$Repository = "OWNER/LocalGroupArchive",
    [ValidateSet("auto", "stable", "ptb", "canary")]
    [string]$DiscordBranch = "auto",
    [switch]$SkipInject
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$ProductVersion = "0.5.0"
$InstallRoot = Join-Path $env:LOCALAPPDATA "LocalGroupArchive"
$ToolsRoot = Join-Path $InstallRoot "tools"
$NodeRoot = Join-Path $ToolsRoot "node"
$PnpmRoot = Join-Path $ToolsRoot "pnpm"
$InjectorPath = Join-Path $ToolsRoot "VencordInstallerCli.exe"
$VencordRoot = Join-Path $InstallRoot "Vencord"
$RollbackRoot = Join-Path $InstallRoot "rollback"
$LogRoot = Join-Path $InstallRoot "logs"
$RunId = Get-Date -Format "yyyyMMdd-HHmmss"
$LogFile = Join-Path $LogRoot "install-$RunId.log"
$StagingRoot = Join-Path $env:TEMP ("LocalGroupArchive-" + [guid]::NewGuid().ToString("N"))
$BackupRoot = Join-Path $RollbackRoot ("Vencord-" + $RunId)
$BackupCreated = $false
$VencordCommit = $null

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host ("  >> " + $Message) -ForegroundColor Cyan
    Add-Content -LiteralPath $LogFile -Value ("[STEP] " + $Message) -Encoding UTF8
}

function Write-Okay([string]$Message) {
    Write-Host ("  [OK] " + $Message) -ForegroundColor Green
    Add-Content -LiteralPath $LogFile -Value ("[OK] " + $Message) -Encoding UTF8
}

function Write-Warn([string]$Message) {
    Write-Host ("  [!] " + $Message) -ForegroundColor Yellow
    Add-Content -LiteralPath $LogFile -Value ("[WARN] " + $Message) -Encoding UTF8
}

function Invoke-Logged {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string]$Label
    )

    Write-Step $Label
    Push-Location $WorkingDirectory
    try {
        $global:LASTEXITCODE = 0
        & $FilePath @Arguments 2>&1 | ForEach-Object {
            $line = [string]$_
            Write-Host ("     " + $line)
            Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
        }
        $exitCode = $LASTEXITCODE
        if ($null -eq $exitCode) { $exitCode = 0 }
        if ($exitCode -ne 0) { throw "$Label failed with exit code $exitCode." }
    } finally {
        Pop-Location
    }
}

function Stop-DiscordForInjection {
    $running = @()
    foreach ($name in @("Discord", "DiscordCanary", "DiscordPTB", "DiscordDevelopment")) {
        $running += @(Get-Process -Name $name -ErrorAction SilentlyContinue)
    }
    $running = @($running | Sort-Object -Property Id -Unique)
    if ($running.Count -eq 0) { return }

    Write-Warn "Discord must restart so the developer build can be injected; closing it now"
    $running | Stop-Process -Force
    $running | Wait-Process -Timeout 15 -ErrorAction SilentlyContinue
}

function Get-Sha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Save-RemoteFile([string]$Uri, [string]$Destination) {
    $headers = @{ "User-Agent" = "LocalGroupArchive-Installer/$ProductVersion" }
    Invoke-WebRequest -UseBasicParsing -Uri $Uri -Headers $headers -OutFile $Destination
    if (!(Test-Path -LiteralPath $Destination) -or (Get-Item -LiteralPath $Destination).Length -eq 0) {
        throw "The download from $Uri was empty."
    }
}

function Install-PortableNode {
    Write-Step "Downloading a private Node.js LTS runtime"
    $index = Invoke-RestMethod -UseBasicParsing -Uri "https://nodejs.org/dist/index.json" -Headers @{ "User-Agent" = "LocalGroupArchive-Installer/$ProductVersion" }
    $release = $index | Where-Object { $_.lts } | Select-Object -First 1
    if (!$release -or !$release.version) { throw "Could not resolve the latest Node.js LTS version." }

    $nativeArchitecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    $architecture = if ($nativeArchitecture -eq "ARM64") { "arm64" } else { "x64" }
    $archiveName = "node-$($release.version)-win-$architecture.zip"
    $baseUri = "https://nodejs.org/dist/$($release.version)"
    $archivePath = Join-Path $StagingRoot $archiveName
    $checksumsPath = Join-Path $StagingRoot "SHASUMS256.txt"
    Save-RemoteFile "$baseUri/$archiveName" $archivePath
    Save-RemoteFile "$baseUri/SHASUMS256.txt" $checksumsPath

    $checksumLine = Get-Content -LiteralPath $checksumsPath | Where-Object { $_ -match ("\s" + [regex]::Escape($archiveName) + "$") } | Select-Object -First 1
    if (!$checksumLine) { throw "Node.js did not publish a SHA-256 checksum for $archiveName." }
    $expected = ($checksumLine -split "\s+")[0].ToLowerInvariant()
    $actual = Get-Sha256 $archivePath
    if ($actual -ne $expected) { throw "Node.js checksum verification failed." }

    $extractRoot = Join-Path $StagingRoot "node-extracted"
    Expand-Archive -LiteralPath $archivePath -DestinationPath $extractRoot -Force
    $source = Get-ChildItem -LiteralPath $extractRoot -Directory | Select-Object -First 1
    if (!$source -or !(Test-Path -LiteralPath (Join-Path $source.FullName "node.exe"))) {
        throw "The downloaded Node.js archive did not contain node.exe."
    }
    if (Test-Path -LiteralPath $NodeRoot) { Remove-Item -LiteralPath $NodeRoot -Recurse -Force }
    Move-Item -LiteralPath $source.FullName -Destination $NodeRoot
    Write-Okay "Node.js $($release.version) verified and installed locally"
}

function Get-FreshVencordSource {
    Write-Step "Downloading the latest official Vencord source"
    $headers = @{ "User-Agent" = "LocalGroupArchive-Installer/$ProductVersion"; "Accept" = "application/vnd.github+json" }
    $head = Invoke-RestMethod -UseBasicParsing -Uri "https://api.github.com/repos/Vendicated/Vencord/commits/main" -Headers $headers
    $commit = [string]$head.sha
    if ($commit -notmatch '^[A-Fa-f0-9]{40}$') { throw "GitHub did not return a valid Vencord commit SHA." }
    $script:VencordCommit = $commit.ToLowerInvariant()

    $archivePath = Join-Path $StagingRoot "Vencord-main.zip"
    Save-RemoteFile "https://github.com/Vendicated/Vencord/archive/$commit.zip" $archivePath
    $extractRoot = Join-Path $StagingRoot "vencord-extracted"
    Expand-Archive -LiteralPath $archivePath -DestinationPath $extractRoot -Force
    $source = Get-ChildItem -LiteralPath $extractRoot -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "package.json") } | Select-Object -First 1
    if (!$source) { throw "The official Vencord archive did not contain package.json." }

    $newRoot = Join-Path $StagingRoot "Vencord-ready"
    Move-Item -LiteralPath $source.FullName -Destination $newRoot

    # Keep unrelated custom plugins when repairing/updating our managed checkout.
    $existingUserPlugins = Join-Path $VencordRoot "src\userplugins"
    $newUserPlugins = Join-Path $newRoot "src\userplugins"
    New-Item -ItemType Directory -Path $newUserPlugins -Force | Out-Null
    if (Test-Path -LiteralPath $existingUserPlugins) {
        Get-ChildItem -LiteralPath $existingUserPlugins -Force | ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination $newUserPlugins -Recurse -Force
        }
    }

    if (Test-Path -LiteralPath $VencordRoot) {
        New-Item -ItemType Directory -Path $RollbackRoot -Force | Out-Null
        Move-Item -LiteralPath $VencordRoot -Destination $BackupRoot
        $script:BackupCreated = $true
    }
    Move-Item -LiteralPath $newRoot -Destination $VencordRoot
    Write-Okay "Official Vencord source is ready at commit $($commit.Substring(0, 12))"
}

function Install-VerifiedVencordInjector {
    Write-Step "Downloading and verifying the official Vencord CLI installer"
    $headers = @{ "User-Agent" = "LocalGroupArchive-Installer/$ProductVersion"; "Accept" = "application/vnd.github+json" }
    $release = Invoke-RestMethod -UseBasicParsing -Uri "https://api.github.com/repos/Vencord/Installer/releases/latest" -Headers $headers
    $binaryAsset = $release.assets | Where-Object { $_.name -eq "VencordInstallerCli.exe" } | Select-Object -First 1
    $checksumAsset = $release.assets | Where-Object { $_.name -eq "checksums.sha256" } | Select-Object -First 1
    if (!$binaryAsset -or !$checksumAsset) { throw "The official Vencord release is missing its CLI installer or checksum list." }

    $downloadedBinary = Join-Path $StagingRoot "VencordInstallerCli.exe"
    $downloadedChecksums = Join-Path $StagingRoot "VencordInstaller-checksums.sha256"
    Save-RemoteFile ([string]$binaryAsset.browser_download_url) $downloadedBinary
    Save-RemoteFile ([string]$checksumAsset.browser_download_url) $downloadedChecksums

    $checksumText = Get-Content -LiteralPath $downloadedChecksums -Raw
    $match = [regex]::Match($checksumText, '(?im)^([A-Fa-f0-9]{64})\s+\*?VencordInstallerCli\.exe\s*$')
    if (!$match.Success) { throw "The official checksum list does not contain VencordInstallerCli.exe." }
    $expected = $match.Groups[1].Value.ToLowerInvariant()
    $actual = Get-Sha256 $downloadedBinary
    if ($actual -ne $expected) { throw "Vencord CLI installer checksum verification failed." }

    if (Test-Path -LiteralPath $InjectorPath) { Remove-Item -LiteralPath $InjectorPath -Force }
    Move-Item -LiteralPath $downloadedBinary -Destination $InjectorPath
    Write-Okay "Official Vencord CLI installer verified ($($release.tag_name))"
    return $InjectorPath
}

function Install-PluginPayload {
    Write-Step "Installing LocalGroupArchive source plugins"
    $mainSource = Join-Path $PayloadRoot "LocalGroupArchive"
    $guideSource = Join-Path $PayloadRoot "LocalGroupArchiveSetup"
    if (!(Test-Path -LiteralPath (Join-Path $mainSource "index.ts"))) { throw "LocalGroupArchive payload is missing." }
    if (!(Test-Path -LiteralPath (Join-Path $guideSource "index.ts"))) { throw "The interactive setup guide payload is missing." }

    $userPlugins = Join-Path $VencordRoot "src\userplugins"
    New-Item -ItemType Directory -Path $userPlugins -Force | Out-Null
    foreach ($name in @("LocalGroupArchive", "LocalGroupArchiveSetup")) {
        $destination = Join-Path $userPlugins $name
        if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Recurse -Force }
        Copy-Item -LiteralPath (Join-Path $PayloadRoot $name) -Destination $destination -Recurse -Force
    }
    Write-Okay "Plugin v$ProductVersion and the live guide were copied"
}

function Install-PnpmForVencord {
    $package = Get-Content -LiteralPath (Join-Path $VencordRoot "package.json") -Raw | ConvertFrom-Json
    $manager = [string]$package.packageManager
    $pnpmVersion = if ($manager -match '^pnpm@([^+]+)') { $Matches[1] } else { "latest" }
    $npm = Join-Path $NodeRoot "npm.cmd"
    if (!(Test-Path -LiteralPath $npm)) { throw "npm.cmd was not found in the private Node.js runtime." }
    if (Test-Path -LiteralPath $PnpmRoot) { Remove-Item -LiteralPath $PnpmRoot -Recurse -Force }
    New-Item -ItemType Directory -Path $PnpmRoot -Force | Out-Null
    Invoke-Logged $npm @("install", "--global", "--prefix", $PnpmRoot, "pnpm@$pnpmVersion") $InstallRoot "Installing Vencord's requested pnpm version"
    $pnpm = Join-Path $PnpmRoot "pnpm.cmd"
    if (!(Test-Path -LiteralPath $pnpm)) { throw "pnpm installation did not produce pnpm.cmd." }
    return $pnpm
}

function Build-And-Inject([string]$Pnpm, [string]$Injector) {
    $oldPath = $env:Path
    $oldVencordUserData = $env:VENCORD_USER_DATA_DIR
    $oldDevInstall = $env:VENCORD_DEV_INSTALL
    $oldVencordHash = $env:VENCORD_HASH
    $oldVencordRemote = $env:VENCORD_REMOTE
    $env:Path = "$NodeRoot;$PnpmRoot;$env:Path"
    # GitHub source archives intentionally contain no .git directory. These official
    # build variables make Vencord reproducible without requiring Git on the user's PC.
    $env:VENCORD_HASH = $VencordCommit.Substring(0, 7)
    $env:VENCORD_REMOTE = "Vendicated/Vencord"
    try {
        Invoke-Logged $Pnpm @("install", "--frozen-lockfile") $VencordRoot "Installing verified Vencord dependencies"
        Invoke-Logged $Pnpm @("build", "--disable-updater") $VencordRoot "Building developer Vencord with LocalGroupArchive"
        if (!$SkipInject) {
            if (!$Injector -or !(Test-Path -LiteralPath $Injector)) { throw "The verified Vencord CLI installer is missing." }
            Stop-DiscordForInjection
            $env:VENCORD_USER_DATA_DIR = $VencordRoot
            $env:VENCORD_DEV_INSTALL = "1"
            Invoke-Logged $Injector @("--install", "--branch", $DiscordBranch) $VencordRoot "Injecting the developer build into Discord ($DiscordBranch)"
        }
    } finally {
        $env:Path = $oldPath
        $env:VENCORD_USER_DATA_DIR = $oldVencordUserData
        $env:VENCORD_DEV_INSTALL = $oldDevInstall
        $env:VENCORD_HASH = $oldVencordHash
        $env:VENCORD_REMOTE = $oldVencordRemote
    }
}

function Restore-Backup {
    if (!$BackupCreated -or !(Test-Path -LiteralPath $BackupRoot)) { return }
    Write-Warn "Restoring the previous managed Vencord source after the failed build"
    if (Test-Path -LiteralPath $VencordRoot) { Remove-Item -LiteralPath $VencordRoot -Recurse -Force }
    Move-Item -LiteralPath $BackupRoot -Destination $VencordRoot
    $script:BackupCreated = $false
}

function Save-State {
    $state = [ordered]@{
        productVersion = $ProductVersion
        action = $Action
        repository = $Repository
        discordBranch = $DiscordBranch
        vencordCommit = $VencordCommit
        installedAt = (Get-Date).ToUniversalTime().ToString("o")
        vencordRoot = $VencordRoot
        logFile = $LogFile
    }
    $state | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $InstallRoot "install-state.json") -Encoding UTF8
}

function Prune-OldRollbacks {
    if (!(Test-Path -LiteralPath $RollbackRoot)) { return }
    $old = @(Get-ChildItem -LiteralPath $RollbackRoot -Directory | Sort-Object LastWriteTime -Descending | Select-Object -Skip 1)
    foreach ($directory in $old) {
        Remove-Item -LiteralPath $directory.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
}

try {
    if ($env:OS -ne "Windows_NT") { throw "This installer currently supports Windows only." }
    if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw "Repository must use the GitHub OWNER/NAME format." }
    New-Item -ItemType Directory -Path $InstallRoot, $ToolsRoot, $RollbackRoot, $LogRoot, $StagingRoot -Force | Out-Null
    Set-Content -LiteralPath $LogFile -Value "LocalGroupArchive v$ProductVersion - $Action - $(Get-Date -Format o)" -Encoding UTF8

    Write-Host ""
    Write-Host "  LocalGroupArchive v$ProductVersion" -ForegroundColor Magenta
    Write-Host "  Private developer-Vencord setup (no administrator required)" -ForegroundColor DarkGray
    Write-Host "  Log: $LogFile" -ForegroundColor DarkGray

    Install-PortableNode
    Get-FreshVencordSource
    Install-PluginPayload
    $pnpm = Install-PnpmForVencord
    $injector = if ($SkipInject) { $null } else { Install-VerifiedVencordInjector }
    Build-And-Inject $pnpm $injector
    Save-State
    Prune-OldRollbacks

    Write-Okay "Installation completed"
    Write-Host ""
    Write-Host "  Developer Vencord was injected automatically into Discord ($DiscordBranch)." -ForegroundColor Green
    Write-Host "  Open/restart Discord. The live spotlight will guide you to enable the plugin." -ForegroundColor Green
    Write-Host "  Your archives remain under Documents\DiscordLocalArchive and are never removed by repair." -ForegroundColor DarkGray
    if ($BackupCreated -and (Test-Path -LiteralPath $BackupRoot)) {
        Write-Host "  Rollback copy kept at: $BackupRoot" -ForegroundColor DarkGray
    }
    exit 0
} catch {
    $message = [string]$_.Exception.Message
    try { Add-Content -LiteralPath $LogFile -Value ("[FATAL] " + $message + "`n" + [string]$_) -Encoding UTF8 } catch { }
    try { Restore-Backup } catch { Write-Warn "Automatic source rollback also failed: $($_.Exception.Message)" }
    Write-Host ""
    Write-Host ("  Installation failed: " + $message) -ForegroundColor Red
    Write-Host ("  Details: " + $LogFile) -ForegroundColor Yellow
    exit 1
} finally {
    if (Test-Path -LiteralPath $StagingRoot) {
        Remove-Item -LiteralPath $StagingRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
