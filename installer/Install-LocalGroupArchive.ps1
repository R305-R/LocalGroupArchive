#Requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateSet("Install", "Repair")]
    [string]$Action = "Install",
    [string]$PayloadRoot = (Join-Path $PSScriptRoot "..\plugin"),
    [string]$Repository = "R305-R/LocalGroupArchive",
    [ValidateSet("auto", "stable", "ptb", "canary")]
    [string]$DiscordBranch = "auto",
    [switch]$SkipInject,
    [string]$ResultFile = "",
    [string]$PrebuiltDistArchive = "",
    [string]$PrebuiltDistChecksum = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$ProductVersion = "0.9.3"
$PinnedVencordCommit = "0850f37fbb1623aa6330764d8f4b1e0b2617dcdf"
$InstallRoot = Join-Path $env:LOCALAPPDATA "LocalGroupArchive"
$VencordRoot = Join-Path $InstallRoot "Vencord"
$VencordDistRoot = Join-Path $VencordRoot "dist"
$RollbackRoot = Join-Path $InstallRoot "rollback"
$LogRoot = Join-Path $InstallRoot "logs"
$LegacyToolsRoot = Join-Path $InstallRoot "tools"
$RunId = Get-Date -Format "yyyyMMdd-HHmmss"
$LogFile = Join-Path $LogRoot "install-$RunId.log"
$StagingRoot = Join-Path $env:TEMP ("LocalGroupArchive-" + [guid]::NewGuid().ToString("N"))
$BackupRoot = Join-Path $RollbackRoot ("Vencord-" + $RunId)
$BackupCreated = $false
$InstalledDiscordProcess = ""

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

function Write-InstallerResult {
    param(
        [Parameter(Mandatory = $true)][ValidateSet("SUCCESS", "FAILED")][string]$Status,
        [Parameter(Mandatory = $true)][string]$Message
    )

    if ([string]::IsNullOrWhiteSpace($ResultFile)) { return }
    $resultDirectory = Split-Path -Parent $ResultFile
    if (![string]::IsNullOrWhiteSpace($resultDirectory)) {
        New-Item -ItemType Directory -Path $resultDirectory -Force | Out-Null
    }

    $details = @("Status: $Status", "Message: $Message", "Log: $LogFile")
    if ($Status -eq "FAILED" -and (Test-Path -LiteralPath $LogFile)) {
        $details += ""
        $details += "Last log lines:"
        $details += @(Get-Content -LiteralPath $LogFile -Tail 14)
    }
    $details | Set-Content -LiteralPath $ResultFile -Encoding UTF8
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

function Resolve-PrebuiltDistArchive {
    $archive = $PrebuiltDistArchive
    $checksum = $PrebuiltDistChecksum

    if ([string]::IsNullOrWhiteSpace($archive)) {
        Write-Step "Downloading the prebuilt verified Vencord bundle"
        $headers = @{ "User-Agent" = "LocalGroupArchive-Installer/$ProductVersion"; "Accept" = "application/vnd.github+json" }
        $release = Invoke-RestMethod -UseBasicParsing -Uri "https://api.github.com/repos/$Repository/releases/tags/v$ProductVersion" -Headers $headers
        $archiveName = "LocalGroupArchive-VencordDist-v$ProductVersion.zip"
        $checksumName = "$archiveName.sha256"
        $archiveAsset = $release.assets | Where-Object { $_.name -eq $archiveName } | Select-Object -First 1
        $checksumAsset = $release.assets | Where-Object { $_.name -eq $checksumName } | Select-Object -First 1
        if (!$archiveAsset -or !$checksumAsset) { throw "GitHub Release v$ProductVersion is missing the prebuilt Vencord bundle or checksum." }

        $archive = Join-Path $StagingRoot $archiveName
        $checksum = Join-Path $StagingRoot $checksumName
        Save-RemoteFile ([string]$archiveAsset.browser_download_url) $archive
        Save-RemoteFile ([string]$checksumAsset.browser_download_url) $checksum
    } else {
        Write-Step "Loading the embedded prebuilt Vencord bundle"
        if ([string]::IsNullOrWhiteSpace($checksum)) { $checksum = "$archive.sha256" }
    }

    if (!(Test-Path -LiteralPath $archive)) { throw "The prebuilt Vencord bundle was not found: $archive" }
    if (!(Test-Path -LiteralPath $checksum)) { throw "The prebuilt Vencord checksum was not found: $checksum" }

    $checksumText = Get-Content -LiteralPath $checksum -Raw
    $match = [regex]::Match($checksumText, '(?im)^([A-Fa-f0-9]{64})(?:\s+\*?.+)?\s*$')
    if (!$match.Success) { throw "The prebuilt Vencord checksum file is invalid." }
    $expected = $match.Groups[1].Value.ToLowerInvariant()
    $actual = Get-Sha256 $archive
    if ($actual -ne $expected) { throw "Prebuilt Vencord bundle checksum verification failed." }
    Write-Okay "Prebuilt Vencord bundle SHA-256 verified"
    return [string]$archive
}

function Install-PrebuiltVencord {
    $archive = Resolve-PrebuiltDistArchive
    Write-Step "Installing the already-built Vencord runtime (no Node.js or pnpm required)"

    $extractRoot = Join-Path $StagingRoot "prebuilt-dist"
    Expand-Archive -LiteralPath $archive -DestinationPath $extractRoot -Force
    $candidate = $extractRoot
    if (Test-Path -LiteralPath (Join-Path $extractRoot "dist")) { $candidate = Join-Path $extractRoot "dist" }

    foreach ($required in @("patcher.js", "preload.js", "renderer.js", "renderer.css")) {
        $requiredPath = Join-Path $candidate $required
        if (!(Test-Path -LiteralPath $requiredPath) -or (Get-Item -LiteralPath $requiredPath).Length -eq 0) {
            throw "The prebuilt Vencord bundle is missing $required."
        }
    }

    $patcherHeader = (Get-Content -LiteralPath (Join-Path $candidate "patcher.js") -TotalCount 4) -join "`n"
    if ($patcherHeader -notmatch [regex]::Escape($PinnedVencordCommit.Substring(0, 7))) {
        throw "The prebuilt Vencord bundle does not match the pinned tested commit."
    }
    if ($patcherHeader -notmatch 'Platform:\s*win32') {
        throw "The prebuilt Vencord bundle was not built for Windows."
    }

    $newRoot = Join-Path $StagingRoot "Vencord-ready"
    $newDist = Join-Path $newRoot "dist"
    New-Item -ItemType Directory -Path $newDist -Force | Out-Null
    Get-ChildItem -LiteralPath $candidate -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $newDist -Recurse -Force
    }

    if (Test-Path -LiteralPath $VencordRoot) {
        New-Item -ItemType Directory -Path $RollbackRoot -Force | Out-Null
        Move-Item -LiteralPath $VencordRoot -Destination $BackupRoot
        $script:BackupCreated = $true
    }
    Move-Item -LiteralPath $newRoot -Destination $VencordRoot
    Write-Okay "Prebuilt Vencord runtime installed at commit $($PinnedVencordCommit.Substring(0, 12))"
}

function Write-PatcherAsar {
    param(
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$PatcherPath
    )

    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $pathJson = ConvertTo-Json -InputObject $PatcherPath -Compress
    $indexText = "require($pathJson)"
    $packageText = "{`n`t`"name`": `"discord`",`n`t`"main`": `"index.js`"`n}"
    $indexBytes = $utf8.GetBytes($indexText)
    $packageBytes = $utf8.GetBytes($packageText)

    $files = [ordered]@{}
    $files["index.js"] = [ordered]@{ size = [int]$indexBytes.Length; offset = "0" }
    $files["package.json"] = [ordered]@{ size = [int]$packageBytes.Length; offset = [string]$indexBytes.Length }
    $headerJson = ConvertTo-Json -InputObject ([ordered]@{ files = $files }) -Compress -Depth 8
    $headerBytes = $utf8.GetBytes($headerJson)
    $headerStringSize = [int]$headerBytes.Length
    $alignedSize = ($headerStringSize + 3) -band (-bnot 3)
    $padding = $alignedSize - $headerStringSize

    $stream = [System.IO.File]::Open($Destination, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try {
        $writer = New-Object System.IO.BinaryWriter($stream)
        try {
            foreach ($value in @(4, ($alignedSize + 8), ($alignedSize + 4), $headerStringSize)) { $writer.Write([int]$value) }
            $writer.Write($headerBytes)
            if ($padding -gt 0) { $writer.Write($utf8.GetBytes(("0" * $padding))) }
            $writer.Write($indexBytes)
            $writer.Write($packageBytes)
        } finally {
            $writer.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
}

function Test-PatcherAsar([string]$Path) {
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 32) { throw "Generated Discord patch app.asar is unexpectedly small." }
    $dataSize = [BitConverter]::ToInt32($bytes, 0)
    $headerStringSize = [BitConverter]::ToInt32($bytes, 12)
    if ($dataSize -ne 4 -or $headerStringSize -le 0 -or (16 + $headerStringSize) -gt $bytes.Length) {
        throw "Generated Discord patch app.asar has an invalid header."
    }
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $headerJson = $utf8.GetString($bytes, 16, $headerStringSize)
    $header = $headerJson | ConvertFrom-Json
    if (!$header.files.'index.js' -or !$header.files.'package.json') {
        throw "Generated Discord patch app.asar is missing its loader files."
    }
}

function Stop-Discord([string]$ProcessName) {
    $running = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue)
    if ($running.Count -eq 0) { return }
    Write-Warn "Discord must restart for the new build; closing $ProcessName now"
    $running | Stop-Process -Force
    $running | Wait-Process -Timeout 15 -ErrorAction SilentlyContinue
}

function Start-Discord([string]$ProcessName) {
    $base = Join-Path $env:LOCALAPPDATA $ProcessName
    $updater = Join-Path $base "Update.exe"
    if (Test-Path -LiteralPath $updater) {
        Start-Process -FilePath $updater -ArgumentList @("--processStart", "$ProcessName.exe")
        return
    }

    $executable = Get-ChildItem -LiteralPath $base -Filter "$ProcessName.exe" -File -Recurse -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1
    if ($executable) { Start-Process -FilePath $executable.FullName }
}

function Resolve-DiscordTarget {
    $branches = [ordered]@{ stable = "Discord"; ptb = "DiscordPTB"; canary = "DiscordCanary" }
    $requested = if ($DiscordBranch -eq "auto") { @($branches.Keys) } else { @($DiscordBranch) }

    foreach ($branch in $requested) {
        $processName = [string]$branches[$branch]
        $base = Join-Path $env:LOCALAPPDATA $processName
        if (!(Test-Path -LiteralPath $base)) { continue }
        $apps = @(Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "app-*" } | Sort-Object Name -Descending)
        foreach ($app in $apps) {
            $resources = Join-Path $app.FullName "resources"
            if (!(Test-Path -LiteralPath $resources)) { continue }
            $appAsar = Join-Path $resources "app.asar"
            $backupAsar = Join-Path $resources "_app.asar"
            if ((Test-Path -LiteralPath $appAsar) -or (Test-Path -LiteralPath $backupAsar)) {
                return [pscustomobject]@{ Branch = $branch; ProcessName = $processName; Resources = $resources }
            }
        }
    }
    throw "Discord was not found. Install/open Discord once, close it, then run this installer again."
}

function Install-DiscordPatch {
    $patcher = Join-Path $VencordDistRoot "patcher.js"
    if (!(Test-Path -LiteralPath $patcher)) { throw "The installed prebuilt Vencord patcher is missing." }

    if ($SkipInject) {
        Write-Step "Validating the generated Discord app.asar loader"
        $testAsar = Join-Path $StagingRoot "app.asar"
        Write-PatcherAsar $testAsar $patcher
        Test-PatcherAsar $testAsar
        Write-Okay "Discord app.asar loader passed structural validation"
        return
    }

    $target = Resolve-DiscordTarget
    Stop-Discord $target.ProcessName
    $appAsar = Join-Path $target.Resources "app.asar"
    $backupAsar = Join-Path $target.Resources "_app.asar"
    $newAsar = Join-Path $target.Resources "app.asar.lga-new"
    $previousPatch = Join-Path $StagingRoot "previous-app.asar"
    $wasPatched = Test-Path -LiteralPath $backupAsar

    Write-Step "Injecting the prebuilt developer Vencord into Discord ($($target.Branch))"
    Write-PatcherAsar $newAsar $patcher
    Test-PatcherAsar $newAsar

    try {
        if ($wasPatched) {
            if (Test-Path -LiteralPath $appAsar) { Move-Item -LiteralPath $appAsar -Destination $previousPatch -Force }
        } else {
            if (!(Test-Path -LiteralPath $appAsar)) { throw "Discord's original app.asar was not found." }
            Move-Item -LiteralPath $appAsar -Destination $backupAsar
        }
        Move-Item -LiteralPath $newAsar -Destination $appAsar
    } catch {
        Remove-Item -LiteralPath $newAsar -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $appAsar -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $previousPatch) {
            Move-Item -LiteralPath $previousPatch -Destination $appAsar -Force
        } elseif (!$wasPatched -and (Test-Path -LiteralPath $backupAsar)) {
            Move-Item -LiteralPath $backupAsar -Destination $appAsar -Force
        }
        throw
    }
    $script:InstalledDiscordProcess = [string]$target.ProcessName
    Write-Okay "Developer Vencord was injected into Discord ($($target.Branch))"
}

function Restore-Backup {
    if (!$BackupCreated -or !(Test-Path -LiteralPath $BackupRoot)) { return }
    Write-Warn "Restoring the previous managed Vencord runtime after the failed setup"
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
        vencordCommit = $PinnedVencordCommit
        installMode = "prebuilt-windows-dist"
        installedAt = (Get-Date).ToUniversalTime().ToString("o")
        vencordRoot = $VencordRoot
        logFile = $LogFile
    }
    $state | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $InstallRoot "install-state.json") -Encoding UTF8
}

function Prune-OldRollbacks {
    if (!(Test-Path -LiteralPath $RollbackRoot)) { return }
    $old = @(Get-ChildItem -LiteralPath $RollbackRoot -Directory | Sort-Object LastWriteTime -Descending | Select-Object -Skip 1)
    foreach ($directory in $old) { Remove-Item -LiteralPath $directory.FullName -Recurse -Force -ErrorAction SilentlyContinue }
}

try {
    if ($env:OS -ne "Windows_NT") { throw "This installer currently supports Windows only." }
    if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw "Repository must use the GitHub OWNER/NAME format." }
    New-Item -ItemType Directory -Path $InstallRoot, $RollbackRoot, $LogRoot, $StagingRoot -Force | Out-Null
    Set-Content -LiteralPath $LogFile -Value "LocalGroupArchive v$ProductVersion - $Action - $(Get-Date -Format o)" -Encoding UTF8

    Write-Host ""
    Write-Host "  LocalGroupArchive v$ProductVersion" -ForegroundColor Magenta
    Write-Host "  Prebuilt developer-Vencord setup (no Node.js, pnpm, or administrator required)" -ForegroundColor DarkGray
    Write-Host "  Log: $LogFile" -ForegroundColor DarkGray

    Install-PrebuiltVencord
    Install-DiscordPatch
    Save-State
    Prune-OldRollbacks
    if (Test-Path -LiteralPath $LegacyToolsRoot) {
        Remove-Item -LiteralPath $LegacyToolsRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (!$SkipInject -and ![string]::IsNullOrWhiteSpace($InstalledDiscordProcess)) {
        Start-Discord $InstalledDiscordProcess
    }

    Write-Okay "Installation completed"
    try { Write-InstallerResult "SUCCESS" "Installation completed successfully." } catch { }
    Write-Host ""
    if ($SkipInject) {
        Write-Host "  Prebuilt Vencord runtime and Discord loader validation completed." -ForegroundColor Green
    } else {
        Write-Host "  Open Discord. The live spotlight will guide you to enable LocalGroupArchive." -ForegroundColor Green
    }
    Write-Host "  Your archives under Documents\DiscordLocalArchive were not changed." -ForegroundColor DarkGray
    exit 0
} catch {
    $message = [string]$_.Exception.Message
    try { Add-Content -LiteralPath $LogFile -Value ("[FATAL] " + $message + "`n" + [string]$_) -Encoding UTF8 } catch { }
    try { Restore-Backup } catch { Write-Warn "Automatic runtime rollback also failed: $($_.Exception.Message)" }
    Write-Host ""
    Write-Host ("  Installation failed: " + $message) -ForegroundColor Red
    Write-Host ("  Details: " + $LogFile) -ForegroundColor Yellow
    try { Write-InstallerResult "FAILED" $message } catch { }
    exit 1
} finally {
    if (Test-Path -LiteralPath $StagingRoot) {
        Remove-Item -LiteralPath $StagingRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
