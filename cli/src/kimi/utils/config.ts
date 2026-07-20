import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '@/ui/logger';

export type KimiLocalConfig = {
    model?: string;
};

export type KimiModelSource = 'explicit' | 'local' | 'default';

const LEGACY_KIMI_DIR = join(homedir(), '.kimi');

/**
 * kimi-code data root (sessions, config, logs). Overridable via KIMI_CODE_HOME;
 * defaults to ~/.kimi-code. See kimi-code docs `configuration/data-locations`.
 */
export function getKimiCodeHome(): string {
    return process.env.KIMI_CODE_HOME || join(homedir(), '.kimi-code');
}

function getConfigCandidates(): string[] {
    return [
        join(getKimiCodeHome(), 'config.toml'),
        join(LEGACY_KIMI_DIR, 'config.toml')
    ];
}

function readTomlFile(path: string): Record<string, unknown> | null {
    if (!existsSync(path)) {
        return null;
    }

    try {
        const raw = readFileSync(path, 'utf-8');
        // Very basic TOML parsing for simple key = "value" lines
        const result: Record<string, unknown> = {};
        for (const line of raw.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const match = trimmed.match(/^([\w_]+)\s*=\s*"([^"]*)"/);
            if (match) {
                result[match[1]] = match[2];
            }
            // Handle bare keys: key = true / key = false / key = 123
            const bareMatch = trimmed.match(/^([\w_]+)\s*=\s*(true|false|\d+)/);
            if (bareMatch) {
                const val = bareMatch[2];
                result[bareMatch[1]] = val === 'true' ? true : val === 'false' ? false : Number(val);
            }
        }
        return result;
    } catch (error) {
        logger.debug(`[kimi-config] Failed to read ${path}:`, error);
    }

    return null;
}

function extractModel(config: Record<string, unknown>): string | undefined {
    const model = config.default_model;
    if (typeof model === 'string' && model.trim().length > 0) {
        return model.trim();
    }
    return undefined;
}

export function readKimiLocalConfig(): KimiLocalConfig {
    for (const candidate of getConfigCandidates()) {
        const configFile = readTomlFile(candidate);
        const model = configFile ? extractModel(configFile) : undefined;
        if (model) {
            return { model };
        }
    }
    return {};
}

/**
 * Resolves which model alias hapi should ask kimi-code to use. Returns
 * `model: undefined` when nothing is configured — callers must then omit
 * `--model` entirely so kimi-code falls back to its own `default_model`
 * (there is no valid built-in alias hapi could hardcode; model aliases are
 * user-defined `[models."<alias>"]` entries in kimi-code's config.toml).
 */
export function resolveKimiRuntimeConfig(opts: {
    model?: string;
} = {}): { model: string | undefined; modelSource: KimiModelSource } {
    if (opts.model) {
        return { model: opts.model, modelSource: 'explicit' };
    }

    const local = readKimiLocalConfig();
    if (local.model) {
        return { model: local.model, modelSource: 'local' };
    }

    return { model: undefined, modelSource: 'default' };
}
