[CmdletBinding()]
param(
    [string]$Version = "",
    [string]$OutputDirectory = "release",
    [string]$ProxyApiUrl = "http://localhost:8082",
    [string]$ProxyBrowseUrl = "http://localhost:8082",
    [switch]$RefreshDependencies,
    [switch]$SkipChecks,
    [switch]$KeepStaging
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Invoke-ExternalCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory
    )

    Push-Location -LiteralPath $WorkingDirectory
    try {
        & $Command @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "Command failed with exit code ${LASTEXITCODE}: $Command $($Arguments -join ' ')"
        }
    } finally {
        Pop-Location
    }
}

function Remove-SafeBuildPath {
    param(
        [Parameter(Mandatory = $true)][string]$Target,
        [Parameter(Mandatory = $true)][string]$AllowedParent
    )

    $resolvedTarget = [IO.Path]::GetFullPath($Target)
    $resolvedParent = [IO.Path]::GetFullPath($AllowedParent).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $expectedPrefix = $resolvedParent + [IO.Path]::DirectorySeparatorChar
    if ($resolvedTarget -eq $resolvedParent -or !$resolvedTarget.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to delete a path outside the build staging directory: $resolvedTarget"
    }
    if (Test-Path -LiteralPath $resolvedTarget) {
        Remove-Item -LiteralPath $resolvedTarget -Recurse -Force
    }
}

function Copy-RequiredItem {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    if (!(Test-Path -LiteralPath $Source)) {
        throw "Required release file is missing: $Source"
    }
    Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
}

function Initialize-ProjectDependencies {
    param(
        [Parameter(Mandatory = $true)][string]$ProjectDirectory,
        [Parameter(Mandatory = $true)][string]$ProjectLabel,
        [Parameter(Mandatory = $true)][string]$DependencyMarker
    )

    $modulesDirectory = Join-Path $ProjectDirectory "node_modules"
    $markerPath = Join-Path $ProjectDirectory $DependencyMarker
    if ((Test-Path -LiteralPath $markerPath) -and !$RefreshDependencies) {
        Write-Host "  Reusing existing $ProjectLabel dependencies." -ForegroundColor DarkGray
        return
    }
    if ((Test-Path -LiteralPath $modulesDirectory) -and !$RefreshDependencies) {
        Write-Host "  Repairing incomplete $ProjectLabel dependencies." -ForegroundColor DarkGray
        Invoke-ExternalCommand $npmCommand @("install", "--no-audit", "--no-fund") $ProjectDirectory
        return
    }
    Invoke-ExternalCommand $npmCommand @("ci", "--no-audit", "--no-fund") $ProjectDirectory
}

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$frontendDirectory = Join-Path $repositoryRoot "vue-request-app"
$backendDirectory = Join-Path $repositoryRoot "backend/nodejs"
$backendPackage = Get-Content -LiteralPath (Join-Path $backendDirectory "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json

if ([string]::IsNullOrWhiteSpace($Version)) {
    $Version = [string]$backendPackage.version
}
if ($Version -notmatch '^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$') {
    throw "Version may only contain letters, digits, dots, underscores, and hyphens (64 characters max)."
}
if ($ProxyApiUrl -notmatch '^https?://') {
    throw "ProxyApiUrl must be an HTTP(S) origin."
}
if ($ProxyBrowseUrl -notmatch '^https?://') {
    throw "ProxyBrowseUrl must be an HTTP(S) origin."
}

$outputRoot = if ([IO.Path]::IsPathRooted($OutputDirectory)) {
    [IO.Path]::GetFullPath($OutputDirectory)
} else {
    [IO.Path]::GetFullPath((Join-Path $repositoryRoot $OutputDirectory))
}
$packageName = "FireflyProxy-v$Version-portable"
$stagingContainer = Join-Path $outputRoot (".staging-{0}-{1}" -f $PID, [Guid]::NewGuid().ToString("N"))
$packageRoot = Join-Path $stagingContainer $packageName
$serverRoot = Join-Path $packageRoot "server"
$archivePath = Join-Path $outputRoot "$packageName.zip"
$checksumPath = "$archivePath.sha256"
$temporaryArchive = Join-Path $stagingContainer "$packageName.zip"

$nodeCommand = (Get-Command node -ErrorAction Stop).Source
$npmCommandInfo = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (!$npmCommandInfo) {
    $npmCommandInfo = Get-Command npm -ErrorAction Stop
}
$npmCommand = $npmCommandInfo.Source
$oldApiUrl = [Environment]::GetEnvironmentVariable("VUE_APP_PROXY_API_URL", "Process")
$oldBrowseUrl = [Environment]::GetEnvironmentVariable("VUE_APP_PROXY_BROWSE_URL", "Process")

New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
New-Item -ItemType Directory -Path $serverRoot -Force | Out-Null

try {
    Write-Host "[1/6] Preparing locked dependencies..." -ForegroundColor Cyan
    Initialize-ProjectDependencies $frontendDirectory "frontend" "node_modules/@vue/cli-service/package.json"
    Initialize-ProjectDependencies $backendDirectory "backend" "node_modules/express/package.json"

    if (!$SkipChecks) {
        Write-Host "[2/6] Running frontend and backend checks..." -ForegroundColor Cyan
        Invoke-ExternalCommand $npmCommand @("test") $frontendDirectory
        Invoke-ExternalCommand $npmCommand @("run", "lint") $frontendDirectory
        Invoke-ExternalCommand $npmCommand @("test") $backendDirectory
        Invoke-ExternalCommand $npmCommand @("run", "lint") $backendDirectory
    } else {
        Write-Host "[2/6] Checks skipped by request." -ForegroundColor Yellow
    }

    Write-Host "[3/6] Building Vue production assets..." -ForegroundColor Cyan
    [Environment]::SetEnvironmentVariable("VUE_APP_PROXY_API_URL", $ProxyApiUrl, "Process")
    [Environment]::SetEnvironmentVariable("VUE_APP_PROXY_BROWSE_URL", $ProxyBrowseUrl, "Process")
    Invoke-ExternalCommand $npmCommand @("run", "build") $frontendDirectory

    Write-Host "[4/6] Collecting server runtime files..." -ForegroundColor Cyan
    $runtimeItems = @(
        "admin-console",
        "api-proxy",
        "browser-proxy",
        "config",
        "core",
        "middleware",
        "app.js",
        "main.js",
        "package.json",
        "package-lock.json"
    )
    foreach ($item in $runtimeItems) {
        Copy-RequiredItem (Join-Path $backendDirectory $item) $serverRoot
    }
    Copy-RequiredItem (Join-Path $repositoryRoot "backend/main.json.example") (Join-Path $serverRoot "main.json.example")
    Copy-RequiredItem (Join-Path $PSScriptRoot "release/bootstrap.js") (Join-Path $serverRoot "bootstrap.js")
    Copy-RequiredItem (Join-Path $PSScriptRoot "release/start.cmd") (Join-Path $packageRoot "start.cmd")
    Copy-RequiredItem (Join-Path $PSScriptRoot "release/start.sh") (Join-Path $packageRoot "start.sh")
    Copy-RequiredItem (Join-Path $PSScriptRoot "release/README.md") (Join-Path $packageRoot "README.md")
    Copy-RequiredItem (Join-Path $repositoryRoot "README.md") (Join-Path $packageRoot "PROJECT-README.md")
    Copy-RequiredItem (Join-Path $repositoryRoot "LICENSE") (Join-Path $packageRoot "LICENSE")

    $webRoot = Join-Path $serverRoot "webPro"
    New-Item -ItemType Directory -Path $webRoot -Force | Out-Null
    Get-ChildItem -LiteralPath (Join-Path $frontendDirectory "dist") -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $webRoot -Recurse -Force
    }

    Write-Host "[5/6] Installing production dependencies..." -ForegroundColor Cyan
    Invoke-ExternalCommand $npmCommand @("ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund") $serverRoot

    $nodeVersion = (& $nodeCommand --version).Trim()
    $gitCommit = (& git -C $repositoryRoot rev-parse HEAD 2>$null)
    if ($LASTEXITCODE -ne 0) { $gitCommit = "unknown" }
    $manifest = [ordered]@{
        name = "FireflyProxy"
        version = $Version
        kind = "portable-node-project"
        nodeRequired = ">=22.16.0"
        builtWithNode = $nodeVersion
        gitCommit = [string]$gitCommit
        proxyApiUrl = $ProxyApiUrl
        proxyBrowseUrl = $ProxyBrowseUrl
        builtAtUtc = [DateTime]::UtcNow.ToString("o")
    }
    $manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $packageRoot "release-manifest.json") -Encoding UTF8

    Write-Host "[6/6] Creating ZIP and SHA-256 checksum..." -ForegroundColor Cyan
    Compress-Archive -LiteralPath $packageRoot -DestinationPath $temporaryArchive -CompressionLevel Optimal
    Move-Item -LiteralPath $temporaryArchive -Destination $archivePath -Force
    $hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $([IO.Path]::GetFileName($archivePath))" | Set-Content -LiteralPath $checksumPath -Encoding ASCII

    Write-Host "Release package created:" -ForegroundColor Green
    Write-Host "  $archivePath"
    Write-Host "  $checksumPath"
    Write-Host "Node.js 22.16.0+ is required. Extract and run start.cmd or sh start.sh." -ForegroundColor Green
} finally {
    if ($null -eq $oldApiUrl) {
        Remove-Item Env:VUE_APP_PROXY_API_URL -ErrorAction SilentlyContinue
    } else {
        [Environment]::SetEnvironmentVariable("VUE_APP_PROXY_API_URL", $oldApiUrl, "Process")
    }
    if ($null -eq $oldBrowseUrl) {
        Remove-Item Env:VUE_APP_PROXY_BROWSE_URL -ErrorAction SilentlyContinue
    } else {
        [Environment]::SetEnvironmentVariable("VUE_APP_PROXY_BROWSE_URL", $oldBrowseUrl, "Process")
    }
    if (!$KeepStaging) {
        Remove-SafeBuildPath $stagingContainer $outputRoot
    } else {
        Write-Host "Staging directory retained: $stagingContainer" -ForegroundColor Yellow
    }
}
