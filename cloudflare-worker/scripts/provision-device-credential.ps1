param(
  [string]$SecretsPath = "..\..\include\secrets.h",
  [string]$TemplatePath = ".\bootstrap-production.sql",
  [string]$OutputPath = "..\.wrangler\bootstrap-production.sql"
)

$ErrorActionPreference = "Stop"

$random = [byte[]]::new(32)
$randomGenerator = [Security.Cryptography.RandomNumberGenerator]::Create()
$randomGenerator.GetBytes($random)
$randomGenerator.Dispose()
$token = [Convert]::ToBase64String($random).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$sha256 = [Security.Cryptography.SHA256]::Create()
$digestBytes = $sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($token))
$sha256.Dispose()
$digest = ([BitConverter]::ToString($digestBytes)).Replace('-', '').ToLowerInvariant()

$resolvedSecrets = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot $SecretsPath))
$secrets = [IO.File]::ReadAllText($resolvedSecrets)
$definition = "#define CLOUDFLARE_DEVICE_TOKEN `"$token`""
if ($secrets -match '(?m)^\s*#define\s+CLOUDFLARE_DEVICE_TOKEN\s+.*$') {
  $secrets = [regex]::Replace(
    $secrets,
    '(?m)^\s*#define\s+CLOUDFLARE_DEVICE_TOKEN\s+.*$',
    $definition
  )
} else {
  $secrets = $secrets.TrimEnd() + "`r`n`r`n// Cloudflare ingestion credential. Never commit this file.`r`n$definition`r`n"
}
[IO.File]::WriteAllText(
  $resolvedSecrets,
  $secrets,
  [Text.UTF8Encoding]::new($false)
)

$resolvedTemplate = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot $TemplatePath))
$resolvedOutput = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot $OutputPath))
$sql = [IO.File]::ReadAllText($resolvedTemplate)
if (-not $sql.Contains('__DEVICE_SECRET_SHA256__')) {
  throw 'Credential digest placeholder is missing from the bootstrap template.'
}
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($resolvedOutput)) | Out-Null
[IO.File]::WriteAllText(
  $resolvedOutput,
  $sql.Replace('__DEVICE_SECRET_SHA256__', $digest),
  [Text.UTF8Encoding]::new($false)
)

Write-Output 'Generated a device credential without printing it.'
Write-Output "Updated ignored secrets file: $resolvedSecrets"
Write-Output "Prepared ignored D1 bootstrap file: $resolvedOutput"
