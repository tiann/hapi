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
    }>;
};

type HookSettings = {
    hooksConfig?: {
        enabled?: boolean;
    };
    hooks: {
        SessionStart: HookCommandConfig[];
    };
    env?: Record<string, string>;
};

export type HookSettingsOptions = {
    filenamePrefix: string;
    logLabel: string;
    hooksEnabled?: boolean;
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

function buildHookSettings(command: string, hooksEnabled?: boolean, env?: Record<string, string>): HookSettings {
    const hooks: HookSettings['hooks'] = {
        SessionStart: [
            {
                matcher: '*',
                hooks: [
                    {
                        type: 'command',
                        command
                    }
                ]
            }
        ]
    };

    const settings: HookSettings = { hooks };
    if (hooksEnabled !== undefined) {
        settings.hooksConfig = {
            enabled: hooksEnabled
        };
    }
    if (env) {
        settings.env = env;
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

    // Read env from default Claude settings if available
    let envFromSettings: Record<string, string> | undefined;
    try {
        const defaultSettingsPath = join(configuration.homeDir, '.claude', 'settings.json');
        const { readFileSync } = require('node:fs');
        const settingsContent = readFileSync(defaultSettingsPath, 'utf-8');
        const settings = JSON.parse(settingsContent);
        if (settings.env && typeof settings.env === 'object') {
            envFromSettings = settings.env;
            logger.debug(`[${options.logLabel}] Loaded env from ${defaultSettingsPath}`);
        }
    } catch (error) {
        logger.debug(`[${options.logLabel}] Could not load env from default settings: ${error}`);
    }

    const settings = buildHookSettings(hookCommand, options.hooksEnabled, envFromSettings);

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
