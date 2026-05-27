import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '@/ui/logger';

export const KIMI_MODEL_ENV = 'KIMI_MODEL';

export type KimiLocalConfig = {
    model?: string;
};

export type KimiModelSource = 'explicit' | 'env' | 'local' | 'default';

const KIMI_DIR = join(homedir(), '.kimi');
const CONFIG_PATH = join(KIMI_DIR, 'config.toml');

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
    const configFile = readTomlFile(CONFIG_PATH);

    return {
        model: configFile ? extractModel(configFile) : undefined
    };
}

export function resolveKimiRuntimeConfig(opts: {
    model?: string;
} = {}): { model: string; modelSource: KimiModelSource } {
    const local = readKimiLocalConfig();

    let modelSource: KimiModelSource = 'default';
    let model: string = 'kimi-k2';

    if (opts.model) {
        model = opts.model;
        modelSource = 'explicit';
    } else if (process.env[KIMI_MODEL_ENV]) {
        model = process.env[KIMI_MODEL_ENV]!;
        modelSource = 'env';
    } else if (local.model) {
        model = local.model;
        modelSource = 'local';
    }

    return { model, modelSource };
}

export function buildKimiEnv(opts: {
    model?: string;
    cwd?: string;
}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
        ...process.env
    };

    if (opts.model) {
        env[KIMI_MODEL_ENV] = opts.model;
    }

    if (opts.cwd) {
        env.KIMI_PROJECT_DIR = opts.cwd;
    }

    return env;
}
