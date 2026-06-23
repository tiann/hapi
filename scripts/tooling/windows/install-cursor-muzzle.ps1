# Install Windows Cursor HAPI muzzle (rules + beforeShellExecution hook).
# Invoked remotely by hapi-install-windows-cursor-muzzle.sh

$ErrorActionPreference = 'Stop'

$rulesDir = Join-Path $env:USERPROFILE '.cursor\rules'
$hooksDir = Join-Path $env:USERPROFILE '.cursor\hooks'
$hooksJson = Join-Path $env:USERPROFILE '.cursor\hooks.json'
$repoRules = Join-Path $env:USERPROFILE '.cursor\rules\hapi-windows-estate.mdc'
$guard = Join-Path $hooksDir 'hapi-production-mutation-guard.mjs'

$bunCandidates = @(
    (Join-Path $env:USERPROFILE '.bun\bin\bun.exe'),
    'C:\Users\HeavyGee\.bun\bin\bun.exe',
    'H:\Apps\bun\bin\bun.exe'
)
$bun = $bunCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $bun) {
    Write-Error 'bun.exe not found — install Bun on Teemo before muzzle hook'
}

New-Item -ItemType Directory -Force -Path $rulesDir, $hooksDir | Out-Null

# Retire hapi-source.mdc
$src = Join-Path $rulesDir 'hapi-source.mdc'
$retired = Join-Path $rulesDir 'hapi-source.mdc.retired'
if (Test-Path $src) {
    $content = Get-Content $src -Raw
    if ($content -notmatch 'RETIRED') {
        Move-Item -Force $src $retired
        @'
---
description: RETIRED — replaced by hapi-windows-estate.mdc (2026-06-20 rogue hub incident)
alwaysApply: false
---

# RETIRED

This rule encouraged SSH to Proxmox without production guardrails.

Use **hapi-windows-estate.mdc** instead.
'@ | Set-Content -Encoding UTF8 $src
        Write-Host "Retired hapi-source.mdc -> hapi-source.mdc.retired + tombstone stub"
    } else {
        Write-Host "hapi-source.mdc already tombstoned"
    }
} else {
    Write-Host "hapi-source.mdc absent (ok)"
}

if (-not (Test-Path $repoRules)) {
    Write-Warning "Missing $repoRules — scp step may have failed"
}

if (-not (Test-Path $guard)) {
    Write-Warning "Missing $guard — scp step may have failed"
}

# Merge hooks.json — bun mjs hook (PowerShell -File stdin bug on CLI)
if (-not (Test-Path $hooksJson)) {
    $doc = [ordered]@{ version = 1; hooks = [ordered]@{} }
} else {
    $doc = Get-Content $hooksJson -Raw | ConvertFrom-Json
    if ($null -eq $doc.hooks) {
        $doc | Add-Member -NotePropertyName hooks -NotePropertyValue ([ordered]@{}) -Force
    }
}

if (-not $doc.hooks.beforeShellExecution) {
    $doc.hooks | Add-Member -NotePropertyName beforeShellExecution -NotePropertyValue @() -Force
}

$guardCmd = "`"$bun`" `"$guard`""
$doc.hooks.beforeShellExecution = @(
    $doc.hooks.beforeShellExecution | Where-Object { $_.command -notlike '*hapi-production-mutation-guard*' }
)
$entry = [ordered]@{ command = $guardCmd; failClosed = $true }
$doc.hooks.beforeShellExecution = @($entry) + @($doc.hooks.beforeShellExecution)
Write-Host "Set beforeShellExecution hook -> bun mjs guard"

($doc | ConvertTo-Json -Depth 8) | Set-Content -Encoding UTF8 $hooksJson
Write-Host "Wrote $hooksJson"
