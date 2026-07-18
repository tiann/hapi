import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '@/ui/logger';
import { DEFAULT_AGY_MODEL, isAgyModelPreset } from '@hapi/protocol';

export const AGY_MODEL_ENV = 'AGY_MODEL';
export const AGY_BLOCKED_AUTH_ENV_KEYS = new Set([
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_GENAI_API_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_CLOUD_PROJECT',
    'GOOGLE_CLOUD_QUOTA_PROJECT',
    'GOOGLE_PROJECT_ID',
    'GCP_PROJECT',
    'GCLOUD_PROJECT',
    'CLOUDSDK_CORE_PROJECT'
]);
export { DEFAULT_AGY_MODEL };

export type AgyLocalConfig = {
    model?: string;
};

export type AgyModelSource = 'explicit' | 'env' | 'local' | 'default';

const AGY_DIR = join(homedir(), '.gemini', 'antigravity-cli');
const SETTINGS_PATH = join(AGY_DIR, 'settings.json');

function readJsonFile(path: string): Record<string, unknown> | null {
    if (!existsSync(path)) {
        return null;
    }

    try {
        const raw = readFileSync(path, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            return parsed as Record<string, unknown>;
        }
    } catch (error) {
        logger.debug(`[agy-config] Failed to read ${path}: ${error}`);
    }

    return null;
}

function extractModel(settings: Record<string, unknown>): string | undefined {
    const modelEntry = settings.model;
    if (modelEntry && typeof modelEntry === 'object') {
        const name = (modelEntry as Record<string, unknown>).name;
        if (typeof name === 'string' && name.trim().length > 0) {
            return name.trim();
        }
    }

    if (typeof modelEntry === 'string' && modelEntry.trim().length > 0) {
        return modelEntry.trim();
    }

    return undefined;
}

export function readAgyLocalConfig(): AgyLocalConfig {
    const settingsFile = readJsonFile(SETTINGS_PATH);
    return {
        model: settingsFile ? extractModel(settingsFile) : undefined
    };
}

export function resolveAgyRuntimeConfig(opts: {
    model?: string;
} = {}): { model: string; modelSource: AgyModelSource } {
    const local = readAgyLocalConfig();

    let modelSource: AgyModelSource = 'default';
    let model: string = DEFAULT_AGY_MODEL;

    const explicitModel = opts.model?.trim();
    const envModel = process.env[AGY_MODEL_ENV]?.trim();

    if (explicitModel && isAgyModelPreset(explicitModel)) {
        model = explicitModel;
        modelSource = 'explicit';
    } else if (explicitModel) {
        logger.debug(`[agy-config] Ignoring unsupported explicit model: ${explicitModel}`);
    } else if (envModel && isAgyModelPreset(envModel)) {
        model = envModel;
        modelSource = 'env';
    } else if (envModel) {
        logger.debug(`[agy-config] Ignoring unsupported ${AGY_MODEL_ENV}: ${envModel}`);
    } else if (local.model && isAgyModelPreset(local.model)) {
        model = local.model;
        modelSource = 'local';
    } else if (local.model) {
        logger.debug(`[agy-config] Ignoring unsupported local model: ${local.model}`);
    }

    return { model, modelSource };
}

export function buildAgyEnv(opts: {
    model?: string;
    cwd?: string;
    baseEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(opts.baseEnv ?? process.env)) {
        if (value === undefined || AGY_BLOCKED_AUTH_ENV_KEYS.has(key)) {
            continue;
        }
        env[key] = value;
    }

    if (opts.model) {
        env[AGY_MODEL_ENV] = opts.model;
    }
    if (opts.cwd) {
        env.AGY_PROJECT_DIR = opts.cwd;
    }

    return env;
}
