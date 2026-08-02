import { join } from 'node:path';
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { getHappyCliCommand } from '@/utils/spawnHappyCLI';
import { shellJoin } from '@/modules/common/shellQuote';

type HookCommandConfig = {
    matcher?: string;
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
// claude falls back to its own permission prompt (which renders in the TUI
// and stalls the chat flow). Give the PreToolUse hook a generous timeout so a
// human has time to respond.
const PRE_TOOL_USE_TIMEOUT_SECONDS = 3600;

type HookSettings = {
    hooksConfig?: {
        enabled?: boolean;
    };
    hooks: {
        SessionStart: HookCommandConfig[];
        UserPromptSubmit?: HookCommandConfig[];
        PreToolUse?: HookCommandConfig[];
    };
};

export type HookSettingsOptions = {
    filenamePrefix: string;
    logLabel: string;
    hooksEnabled?: boolean;
    /**
     * Also forward UserPromptSubmit and PreToolUse hooks. Unlike SessionStart,
     * their payloads carry `permission_mode`, letting HAPI track the mode the
     * user picks inside the interactive TUI (shift+tab). Keep this off for the
     * remote SDK process: these hooks block Claude while the forwarder runs,
     * and remote permission state is owned by the hub/RPC path anyway.
     */
    trackPermissionMode?: boolean;
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

export function buildHookSettings(
    command: string,
    hooksEnabled?: boolean,
    trackPermissionMode?: boolean,
    includePreToolUse?: boolean
): HookSettings {
    const commandHook = {
        hooks: [
            {
                type: 'command' as const,
                command
            }
        ]
    };
    const hooks: HookSettings['hooks'] = {
        SessionStart: [{ matcher: '*', ...commandHook }]
    };
    if (trackPermissionMode) {
        hooks.UserPromptSubmit = [commandHook];
        hooks.PreToolUse = [{ matcher: '*', ...commandHook }];
    }

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
        '--flavor', 'claude',
        '--port',
        String(port),
        '--token',
        token
    ]);
    const hookCommand = shellJoin([command, ...args]);

    const settings = buildHookSettings(
        hookCommand,
        options.hooksEnabled,
        options.trackPermissionMode,
        options.includePreToolUse
    );

    writeFileSync(filepath, JSON.stringify(settings, null, 4));
    logger.debug(`[${options.logLabel}] Created hook settings file: ${filepath}`);

    return filepath;
}

// ---------------------------------------------------------------------------
// agy hooks.json generation
//
// agy's hooks.json schema differs from claude's: it is a flat map of
// hookName → { PreToolUse: [...] } entries. There is no SessionStart event
// in agy (session identity comes from the PreToolUse stdin conversationId).
// The format:
//   { "<hookName>": { "PreToolUse": [{ "matcher": "*", "hooks": [{ "command": "...", "timeout": N }] }] } }
// ---------------------------------------------------------------------------

type AgyHookEntry = {
    matcher: string;
    hooks: Array<{
        command: string;
        timeout?: number;
    }>;
};

type AgyHooksJson = {
    [hookName: string]: {
        PreToolUse: AgyHookEntry[];
    };
};

/**
 * Build the JSON string for agy's hooks.json. The returned string is suitable
 * for writing into a workspace-local .agents/hooks.json carrier.
 *
 * agy does not use a `type` field on hook entries (unlike claude which requires
 * `"type": "command"`). The timeout is in seconds; 3600 gives the user an hour
 * to answer a permission prompt on their phone.
 */
export function buildAgyHooksJson(command: string, hookName = 'hapi-bridge'): string {
    const content: AgyHooksJson = {
        [hookName]: {
            PreToolUse: [
                {
                    matcher: '*',
                    hooks: [{ command, timeout: PRE_TOOL_USE_TIMEOUT_SECONDS }]
                }
            ]
        }
    };
    return JSON.stringify(content, null, 4);
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
