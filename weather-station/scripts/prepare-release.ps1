param(
    [Parameter(Mandatory=$true)][string]$Version,
    [Parameter(Mandatory=$true)][string]$PrivateKey
)
$ErrorActionPreference = "Stop"
$projectPath = Split-Path $PSScriptRoot -Parent
$config = Join-Path $projectPath "include\secrets.h"
if (!(Test-Path -LiteralPath $config)) { throw "Configure secrets.h before preparing an OTA release." }
# Run the common validation before building; never print secrets.
& node (Join-Path $PSScriptRoot "release.mjs") check-config $config $PrivateKey
if ($LASTEXITCODE -ne 0) { throw "Configuration is not ready for a release." }
$cmake = Get-Content -LiteralPath (Join-Path $projectPath "CMakeLists.txt") -Raw
if ($cmake -notmatch ('set\(PROJECT_VER\s+"' + [regex]::Escape($Version) + '"\)')) {
    throw "Set PROJECT_VER in CMakeLists.txt to the requested version first. Source is not edited automatically."
}
& (Join-Path $PSScriptRoot "build.ps1") -Environment firebeetle_c6
if ($LASTEXITCODE -ne 0) { throw "Build failed." }
$releasePath = Join-Path $projectPath "releases\$Version"
if (Test-Path -LiteralPath $releasePath) { throw "Release directory already exists; use a new version. Nothing overwritten." }
New-Item -ItemType Directory -Path $releasePath | Out-Null
$image = Join-Path $releasePath "firmware.bin"
Copy-Item -LiteralPath (Join-Path $projectPath ".pio\artifacts\firebeetle_c6\firmware.bin") -Destination $image
& node (Join-Path $PSScriptRoot "release.mjs") sign $image $Version $PrivateKey (Join-Path $releasePath "manifest.json")
if ($LASTEXITCODE -ne 0) { throw "Signing failed; do not upload the release directory." }
Write-Host "Signed release prepared: $releasePath"
Write-Host "No device flashed and no deployment approved. Upload both files through /admin/station/."
