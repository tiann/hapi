import { join } from 'node:path';
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { getHappyCliCommand } from '@/utils/spawnHappyCLI';
import { shellJoin } from '@/modules/common/shellQuote';
import { LOCAL_PERMISSION_TIMEOUT_SECONDS } from '@/claude/utils/localPermissionProtocol';

type HookCommandConfig = {
    matcher?: string;
    hooks: Array<{
        type: 'command';
        command: string;
        /** Per-command timeout in SECONDS (claude's hook schema). */
        timeout?: number;
    }>;
};

type HookSettings = {
    hooksConfig?: {
        enabled?: boolean;
    };
    hooks: {
        SessionStart: HookCommandConfig[];
        UserPromptSubmit?: HookCommandConfig[];
        PreToolUse?: HookCommandConfig[];
        PermissionRequest?: HookCommandConfig[];
        PostToolUse?: HookCommandConfig[];
        PostToolUseFailure?: HookCommandConfig[];
        SessionEnd?: HookCommandConfig[];
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
    /** Mirror main-session permissions without suppressing the native dialog. Local only. */
    includeLocalPermissions?: boolean;
};

export function buildHookSettings(
    command: string,
    hooksEnabled?: boolean,
    trackPermissionMode?: boolean,
    includeLocalPermissions?: boolean
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
    if (trackPermissionMode || includeLocalPermissions) {
        hooks.UserPromptSubmit = [commandHook];
        hooks.PreToolUse = [{ matcher: '*', ...commandHook }];
    }

    if (includeLocalPermissions) {
        hooks.PermissionRequest = [{
            matcher: '*',
            hooks: [{ type: 'command', command, timeout: LOCAL_PERMISSION_TIMEOUT_SECONDS }]
        }];
        hooks.PostToolUse = [{ matcher: '*', ...commandHook }];
        hooks.PostToolUseFailure = [{ matcher: '*', ...commandHook }];
        hooks.SessionEnd = [{ matcher: '*', ...commandHook }];
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
        options.includeLocalPermissions
    );

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
