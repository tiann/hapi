# Cursor beforeShellExecution hook (Windows): refuse SSH mutations against Linux :3006 production.
# Install: scripts/tooling/hapi-install-windows-cursor-muzzle.sh
# Bypass: HAPI_OPERATOR_PRODUCTION_MUTATION_OVERRIDE=1 (operator interactive shell only)

$ErrorActionPreference = 'Stop'

function Test-ControllingTTY {
    try {
        return [Console]::IsInputRedirected -eq $false
    } catch {
        return $false
    }
}

function Get-CommandLineFromHookInput([string]$Raw) {
    if ([string]::IsNullOrWhiteSpace($Raw)) { return '' }
    try {
        $obj = $Raw | ConvertFrom-Json
    } catch {
        return ''
    }
    foreach ($key in @('command', 'cmd')) {
        if ($null -ne $obj.$key -and [string]$obj.$key -ne '') { return [string]$obj.$key }
        if ($null -ne $obj.input -and $null -ne $obj.input.$key -and [string]$obj.input.$key -ne '') { return [string]$obj.input.$key }
        if ($null -ne $obj.tool_input -and $null -ne $obj.tool_input.$key -and [string]$obj.tool_input.$key -ne '') { return [string]$obj.tool_input.$key }
    }
    return ''
}

function Test-ProductionMutation([string]$Command) {
    if ([string]::IsNullOrWhiteSpace($Command)) { return $false }
    $lc = $Command.ToLowerInvariant()

    $patterns = @(
        'hapi-driver-db-prep',
        'hapi-use-worktree',
        'hapi-use-driver',
        'hapi-driver-rebuild.*--activate',
        'hapi-watch-activate-driver',
        'hapi_stack_switch_yes=1',
        'nohup.*(bun run|src/index\.ts)',
        'manual-hub',
        '(^|[\s;|&])(kill|pkill|fuser)[\s].*(3006|hapi-hub|/hub/|src/index\.ts)',
        'systemctl[\s]+(stop|restart|kill|disable|mask)[\s]+hapi-(hub|runner|runner-watchdog)',
        'git reset --hard.*(driver|hapi/driver)',
        'embeddedassets.*driver',
        '(\.hapi/hapi\.db|hapi\.db\.bak)'
    )

    foreach ($pat in $patterns) {
        if ($lc -match $pat) { return $true }
    }
    return $false
}

function Test-RemoteSsh([string]$Command) {
    if ([string]::IsNullOrWhiteSpace($Command)) { return $false }
    $lc = $Command.ToLowerInvariant()
    return ($lc -match '(^|[\s|&;])(ssh|scp|rsync)[\s]' -or $lc -match 'wsl[\s].*ssh')
}

$raw = [Console]::In.ReadToEnd()
$cmd = Get-CommandLineFromHookInput $raw

if ([string]::IsNullOrWhiteSpace($cmd)) {
    Write-Output '{ "permission": "allow" }'
    exit 0
}

if ($env:HAPI_OPERATOR_PRODUCTION_MUTATION_OVERRIDE -eq '1' -and (Test-ControllingTTY)) {
    Write-Output '{ "permission": "allow" }'
    exit 0
}

if ((Test-RemoteSsh $cmd) -and (Test-ProductionMutation $cmd)) {
    $msg = @"
Production HAPI mutation over SSH BLOCKED (Windows estate muzzle).

Command: $cmd

You are a Windows estate agent. Do NOT kill/nohup/stack-switch/DB-prep Linux :3006.
REFUSE means STOP — report stderr to the operator.

Pre-soup proof: hapi-peer-stack up <name> (:3100+).
Soup on :3006: operator manifest + hapi-driver-rebuild + promotion.

Rule: C:\Users\HeavyGee\.cursor\rules\hapi-windows-estate.mdc
"@
    $payload = @{
        permission    = 'deny'
        agent_message = $msg
        user_message  = 'Blocked: SSH production HAPI mutation. See hapi-windows-estate.mdc.'
    }
    $payload | ConvertTo-Json -Compress
    exit 0
}

Write-Output '{ "permission": "allow" }'
exit 0
