#!/usr/bin/env bun
/**
 * Cursor beforeShellExecution hook (Windows / HAPI CLI).
 * Blocks SSH mutations against Linux :3006 production.
 */
const raw = await Bun.stdin.text();
let cmd = '';
try {
    const obj = raw ? JSON.parse(raw) : {};
    cmd =
        obj.command ??
        obj.input?.command ??
        obj.tool_input?.command ??
        obj.cmd ??
        obj.input?.cmd ??
        obj.tool_input?.cmd ??
        '';
} catch {
    cmd = '';
}

const override =
    process.env.HAPI_OPERATOR_PRODUCTION_MUTATION_OVERRIDE === '1' &&
    process.stdin.isTTY;

if (override) {
    console.log(JSON.stringify({ permission: 'allow' }));
    process.exit(0);
}

// Audit trail for hook debugging (append-only, small)
try {
    const audit = `${process.env.TEMP ?? 'C:\\\\Temp'}\\\\hapi-production-mutation-guard.log`;
    const line = `[${new Date().toISOString()}] cmd=${JSON.stringify(cmd).slice(0, 500)}\n`;
    await Bun.write(audit, (await Bun.file(audit).exists() ? await Bun.file(audit).text() : '') + line, {
        createPath: true,
    });
} catch {
    // ignore audit failures
}

if (!cmd) {
    console.log(
        JSON.stringify({
            permission: 'deny',
            user_message: 'Blocked: production guard received empty command (fail closed).',
            agent_message:
                'Production mutation guard: empty command on stdin — denying (HAPI CLI hook must receive beforeShellExecution JSON).',
        }),
    );
    process.exit(0);
}

const lc = cmd.toLowerCase();

const mutationPatterns = [
    /hapi-driver-db-prep/,
    /hapi-use-worktree/,
    /hapi-use-driver/,
    /hapi-driver-rebuild.*--activate/,
    /hapi-watch-activate-driver/,
    /hapi_stack_switch_yes=1/,
    /nohup.*(bun run|src\/index\.ts)/,
    /manual-hub/,
    /(^|[\s;|&])(kill|pkill|fuser)[\s].*(3006|hapi-hub|\/hub\/|src\/index\.ts)/,
    /systemctl[\s]+(stop|restart|kill|disable|mask)[\s]+hapi-(hub|runner|runner-watchdog)/,
    /git reset --hard.*(driver|hapi\/driver)/,
    /embeddedassets.*driver/,
    /(\.hapi\/hapi\.db|hapi\.db\.bak)/,
];

const remoteSsh =
    /(^|[\s|&;])(ssh|scp|rsync)[\s]/.test(lc) || /wsl[\s].*ssh/.test(lc);

const isMutation = mutationPatterns.some((re) => re.test(lc));

if (remoteSsh && isMutation) {
    const agentMessage = [
        'Production HAPI mutation over SSH BLOCKED (Windows estate muzzle).',
        '',
        `Command: ${cmd}`,
        '',
        'Do NOT kill/nohup/stack-switch/DB-prep Linux :3006.',
        'REFUSE means STOP — report stderr to the operator.',
        '',
        'Pre-soup proof: hapi-peer-stack up <name> (:3100+).',
        '',
        'Rule: C:\\Users\\HeavyGee\\.cursor\\rules\\hapi-windows-estate.mdc',
    ].join('\n');

    console.log(
        JSON.stringify({
            permission: 'deny',
            user_message: 'Blocked: SSH production HAPI mutation. See hapi-windows-estate.mdc.',
            agent_message: agentMessage,
        }),
    );
    process.exit(0);
}

console.log(JSON.stringify({ permission: 'allow' }));
process.exit(0);
