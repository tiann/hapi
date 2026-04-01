import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '@/ui/logger';
import { DEFAULT_GEMINI_MODEL } from '@hapi/protocol';

export const GEMINI_API_KEY_ENV = 'GEMINI_API_KEY';
export const GOOGLE_API_KEY_ENV = 'GOOGLE_API_KEY';
export const GEMINI_MODEL_ENV = 'GEMINI_MODEL';
export { DEFAULT_GEMINI_MODEL };

export type GeminiLocalConfig = {
    token?: string;
    model?: string;
};

export type GeminiModelSource = 'explicit' | 'env' | 'local' | 'default';

const GEMINI_DIR = join(homedir(), '.gemini');
const SETTINGS_PATH = join(GEMINI_DIR, 'settings.json');
const CONFIG_PATH = join(GEMINI_DIR, 'config.json');
const OAUTH_PATH = join(GEMINI_DIR, 'oauth_creds.json');

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
        logger.debug(`[gemini-config] Failed to read ${path}: ${error}`);
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

    const model = settings.model;
    if (typeof model === 'string' && model.trim().length > 0) {
        return model.trim();
    }

    return undefined;
}

function extractToken(settings: Record<string, unknown>): string | undefined {
    const tokenKeys = ['access_token', 'token', 'apiKey', GEMINI_API_KEY_ENV, GOOGLE_API_KEY_ENV];
    for (const key of tokenKeys) {
        const value = settings[key];
        if (typeof value === 'string' && value.trim().length > 0) {
            return value.trim();
        }
    }
    return undefined;
}

export function readGeminiLocalConfig(): GeminiLocalConfig {
    const settingsFile = readJsonFile(SETTINGS_PATH);
    const configFile = readJsonFile(CONFIG_PATH);
    const oauthFile = readJsonFile(OAUTH_PATH);

    const model = settingsFile ? extractModel(settingsFile) : undefined;
    const token = oauthFile
        ? extractToken(oauthFile)
        : configFile
            ? extractToken(configFile)
            : undefined;

    return {
        model,
        token
    };
}

export function resolveGeminiRuntimeConfig(opts: {
    model?: string;
    token?: string;
} = {}): { model: string; token?: string; modelSource: GeminiModelSource } {
    const local = readGeminiLocalConfig();

    let modelSource: GeminiModelSource = 'default';
    let model: string = DEFAULT_GEMINI_MODEL;

    if (opts.model) {
        model = opts.model;
        modelSource = 'explicit';
    } else if (process.env[GEMINI_MODEL_ENV]) {
        model = process.env[GEMINI_MODEL_ENV]!;
        modelSource = 'env';
    } else if (local.model) {
        model = local.model;
        modelSource = 'local';
    }

    const token = opts.token
        ?? process.env[GEMINI_API_KEY_ENV]
        ?? process.env[GOOGLE_API_KEY_ENV]
        ?? local.token;

    return { model, token, modelSource };
}

export function buildGeminiEnv(opts: {
    model?: string;
    token?: string;
    hookSettingsPath?: string;
    cwd?: string;
}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
        ...process.env
    };

    if (opts.model) {
        env[GEMINI_MODEL_ENV] = opts.model;
    }

    if (opts.token && !env[GEMINI_API_KEY_ENV] && !env[GOOGLE_API_KEY_ENV]) {
        env[GEMINI_API_KEY_ENV] = opts.token;
    }

    if (opts.hookSettingsPath) {
        env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = opts.hookSettingsPath;
    }

    if (opts.cwd) {
        env.GEMINI_PROJECT_DIR = opts.cwd;
    }

    return env;
}
