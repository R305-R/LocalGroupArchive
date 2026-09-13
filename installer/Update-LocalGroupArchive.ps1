#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Repository,
    [string]$CurrentVersion = "0.5.0"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$TempRoot = Join-Path $env:TEMP ("LocalGroupArchive-Update-" + [guid]::NewGuid().ToString("N"))

try {
    if ($Repository -like "OWNER/*" -or $Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
        throw "This build does not contain a valid GitHub repository name."
    }
    New-Item -ItemType Directory -Path $TempRoot -Force | Out-Null
    $headers = @{ "User-Agent" = "LocalGroupArchive-Updater/$CurrentVersion"; "Accept" = "application/vnd.github+json" }
    Write-Host "Checking GitHub for LocalGroupArchive updates..." -ForegroundColor Cyan
    $release = Invoke-RestMethod -UseBasicParsing -Headers $headers -Uri "https://api.github.com/repos/$Repository/releases/latest"
    $latest = ([string]$release.tag_name).TrimStart("v")
    if ([version]$latest -le [version]$CurrentVersion) {
        Write-Host "You already have the latest version ($CurrentVersion)." -ForegroundColor Green
        exit 0
    }

    $installerAsset = $release.assets | Where-Object { $_.name -match '^LocalGroupArchive-Setup.*\.exe$' } | Select-Object -First 1
    $checksumAsset = $release.assets | Where-Object { $_.name -match '\.sha256$' } | Select-Object -First 1
    if (!$installerAsset -or !$checksumAsset) { throw "The latest release is missing its installer or SHA-256 file." }

    $installer = Join-Path $TempRoot $installerAsset.name
    $checksum = Join-Path $TempRoot $checksumAsset.name
    Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri $installerAsset.browser_download_url -OutFile $installer
    Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri $checksumAsset.browser_download_url -OutFile $checksum
    $expected = [regex]::Match((Get-Content -LiteralPath $checksum -Raw), '[A-Fa-f0-9]{64}').Value.ToLowerInvariant()
    $actual = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
    if (!$expected -or $expected -ne $actual) { throw "The downloaded update failed SHA-256 verification." }

    Write-Host "Installing verified update v$latest..." -ForegroundColor Magenta
    $process = Start-Process -FilePath $installer -ArgumentList "/SILENT", "/SUPPRESSMSGBOXES" -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "The update installer exited with code $($process.ExitCode)." }
    Write-Host "LocalGroupArchive was updated to v$latest." -ForegroundColor Green
} catch {
    Write-Host ("Update failed: " + $_.Exception.Message) -ForegroundColor Red
    exit 1
} finally {
    if (Test-Path -LiteralPath $TempRoot) { Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
