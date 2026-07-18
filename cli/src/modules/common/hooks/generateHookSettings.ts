import { join } from 'node:path';
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { getHappyCliCommand } from '@/utils/spawnHappyCLI';

type HookCommandConfig = {
    matcher: string;
    hooks: Array<{
        type: 'command';
        command: string;
        /** Per-command timeout in SECONDS (claude's hook schema). */
        timeout?: number;
    }>;
};

// PreToolUse bridges a tool approval to the web and blocks the (synchronous)
// hook until the user answers on their phone — which can take minutes. claude's
// default command-hook timeout is 60s; on timeout the decision is dropped and
// claude falls back to its own permission prompt (in PTY that renders in the TUI
// and stalls the chat flow). Give the PreToolUse hook a generous timeout so a
// human has time to respond.
const PRE_TOOL_USE_TIMEOUT_SECONDS = 3600;

type HookSettings = {
    hooksConfig?: {
        enabled?: boolean;
    };
    hooks: {
        SessionStart: HookCommandConfig[];
        PreToolUse?: HookCommandConfig[];
    };
};

export type HookSettingsOptions = {
    filenamePrefix: string;
    logLabel: string;
    hooksEnabled?: boolean;
    /**
     * Register a PreToolUse hook (PTY mode only). The SDK path routes tool
     * approvals through the SDK's canUseTool callback, so it must NOT register
     * PreToolUse or every tool would be double-handled. PTY sessions have no
     * SDK callback, so they rely on this hook to bridge tool approvals to the
     * web. The same forwarder command serves both events; it branches on the
     * stdin `hook_event_name`.
     */
    includePreToolUse?: boolean;
};

function shellQuote(value: string): string {
    if (value.length === 0) {
        return '""';
    }

    if (/^[A-Za-z0-9_\/:=-]+$/.test(value)) {
        return value;
    }

    return '"' + value.replace(/(["\\$`])/g, '\\$1') + '"';
}

function shellJoin(parts: string[]): string {
    return parts.map(shellQuote).join(' ');
}

function buildHookSettings(command: string, hooksEnabled?: boolean, includePreToolUse?: boolean): HookSettings {
    const hooks: HookSettings['hooks'] = {
        SessionStart: [
            {
                matcher: '*',
                hooks: [{ type: 'command', command }]
            }
        ]
    };

    if (includePreToolUse) {
        // matcher '*' matches every tool name (claude's matcher: !q || q==='*' → all).
        // The same forwarder command serves both events; it branches on the
        // stdin hook_event_name. The long timeout keeps the (blocking) hook
        // alive while the user approves on their phone.
        hooks.PreToolUse = [
            {
                matcher: '*',
                hooks: [{ type: 'command', command, timeout: PRE_TOOL_USE_TIMEOUT_SECONDS }]
            }
        ];
    }

    const settings: HookSettings = { hooks };
    if (hooksEnabled !== undefined) {
        settings.hooksConfig = {
            enabled: hooksEnabled
        };
    }

    return settings;
}

export function generateHookSettingsFile(
    port: number,
    token: string,
    options: HookSettingsOptions
): string {
    const hooksDir = join(configuration.happyHomeDir, 'tmp', 'hooks');
    mkdirSync(hooksDir, { recursive: true });

    const filename = `${options.filenamePrefix}-${process.pid}.json`;
    const filepath = join(hooksDir, filename);

    const { command, args } = getHappyCliCommand([
        'hook-forwarder',
        '--port',
        String(port),
        '--token',
        token
    ]);
    const hookCommand = shellJoin([command, ...args]);

    const settings = buildHookSettings(hookCommand, options.hooksEnabled, options.includePreToolUse);

    writeFileSync(filepath, JSON.stringify(settings, null, 4));
    logger.debug(`[${options.logLabel}] Created hook settings file: ${filepath}`);

    return filepath;
}

export function cleanupHookSettingsFile(filepath: string, logLabel: string): void {
    try {
        if (existsSync(filepath)) {
            unlinkSync(filepath);
            logger.debug(`[${logLabel}] Cleaned up hook settings file: ${filepath}`);
        }
    } catch (error) {
        logger.debug(`[${logLabel}] Failed to cleanup hook settings file: ${error}`);
    }
}
