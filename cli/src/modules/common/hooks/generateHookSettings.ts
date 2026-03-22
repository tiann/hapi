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
    permissions?: {
        deny?: string[];
    };
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

function buildHookSettings(command: string, hooksEnabled?: boolean): HookSettings {
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

    // Deny dangerous Bash patterns as a safety net.
    // Even with --dangerously-skip-permissions, deny rules are still enforced.
    settings.permissions = {
        deny: [
            'Bash(rm -rf:*)',
            'Bash(rm -r /:*)',
            'Bash(sudo rm:*)',
            'Bash(sudo chmod:*)',
            'Bash(sudo chown:*)',
            'Bash(mkfs:*)',
            'Bash(dd if=:*)',
            'Bash(git push --force:*)',
            'Bash(git push -f:*)',
            'Bash(git reset --hard:*)',
            'Bash(> /dev/:*)',
            'Bash(chmod 777:*)',
        ]
    };

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

    const settings = buildHookSettings(hookCommand, options.hooksEnabled);

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
