param([string]$Environment = "firebeetle_c6")
$ErrorActionPreference = "Stop"
# ESP-IDF rejects spaces in project paths. Source/secrets stay in this project;
# only a local build copy is staged outside Dropbox. No upload is performed.
$projectPath = Split-Path $PSScriptRoot -Parent
$buildPath = Join-Path $env:LOCALAPPDATA "HydroponicsBuild\weather-station"
if ($buildPath -match '\s') { throw "Choose a LOCALAPPDATA build path without whitespace." }
New-Item -ItemType Directory -Force -Path $buildPath | Out-Null
foreach ($file in @("platformio.ini", "CMakeLists.txt", "sdkconfig.defaults", "partitions.csv")) {
    Copy-Item -LiteralPath (Join-Path $projectPath $file) -Destination $buildPath -Force
}
foreach ($folder in @("include", "src")) {
    Copy-Item -LiteralPath (Join-Path $projectPath $folder) -Destination $buildPath -Recurse -Force
}
# Prevent a removed secrets.h from silently surviving in the build copy.
$stagedSecret = Join-Path $buildPath "include\secrets.h"
if (!(Test-Path -LiteralPath (Join-Path $projectPath "include\secrets.h")) -and
    (Test-Path -LiteralPath $stagedSecret)) { Remove-Item -LiteralPath $stagedSecret }
& pio run --project-dir $buildPath --environment $Environment
if ($LASTEXITCODE -ne 0) { throw "Firmware build failed ($LASTEXITCODE)." }
$artifacts = Join-Path $projectPath ".pio\artifacts\$Environment"
New-Item -ItemType Directory -Force -Path $artifacts | Out-Null
foreach ($file in @("firmware.bin", "firmware.elf", "bootloader.bin", "partitions.bin")) {
    Copy-Item -LiteralPath (Join-Path $buildPath ".pio\build\$Environment\$file") -Destination $artifacts -Force
}
Write-Host "Build only completed. Artifacts: $artifacts"
Write-Host "Build copy (may contain secrets): $buildPath"
