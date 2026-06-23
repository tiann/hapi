# Deploy project-level Cursor muzzle into the Windows agent workspace (HAPI CLI cwd).
param(
    [string]$Workspace = 'H:\Users\heavygee\Documents\gavinc\misc'
)

$ErrorActionPreference = 'Stop'
$cursor = Join-Path $Workspace '.cursor'
$rules = Join-Path $cursor 'rules'
$hooks = Join-Path $cursor 'hooks'
New-Item -ItemType Directory -Force -Path $rules, $hooks | Out-Null

Copy-Item -Force (Join-Path $env:USERPROFILE '.cursor\rules\hapi-windows-estate.mdc') (Join-Path $rules 'hapi-windows-estate.mdc')

$bun = 'C:\Users\HeavyGee\.bun\bin\bun.exe'
if (-not (Test-Path $bun)) {
    Write-Error "bun not found at $bun"
}
$guardSrc = Join-Path $env:USERPROFILE '.cursor\hooks\hapi-production-mutation-guard.mjs'
$guardDst = Join-Path $hooks 'hapi-production-mutation-guard.mjs'
Copy-Item -Force $guardSrc $guardDst

$hookDoc = [ordered]@{
    version = 1
    hooks   = [ordered]@{
        beforeShellExecution = @(
            [ordered]@{
                command    = "`"$bun`" `"$guardDst`""
                failClosed = $true
            }
        )
    }
}
($hookDoc | ConvertTo-Json -Depth 6) | Set-Content -Encoding UTF8 (Join-Path $cursor 'hooks.json')
Write-Host "Workspace muzzle deployed: $cursor"
