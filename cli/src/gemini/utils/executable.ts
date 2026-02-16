import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '@/ui/logger';

function findWindowsGeminiPath(): string | null {
    const homeDir = homedir();
    const candidates = [
        join(homeDir, '.local', 'bin', 'gemini.exe'),
        join(homeDir, 'AppData', 'Local', 'Programs', 'gemini', 'gemini.exe')
    ];

    for (const candidate of candidates) {
        if (existsSync(candidate)) {
            logger.debug(`[Gemini] Found Windows gemini.exe at: ${candidate}`);
            return candidate;
        }
    }

    try {
        const result = execSync('where gemini.exe', {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: homeDir
        }).trim().split('\n')[0].trim();
        if (result && existsSync(result)) {
            return result;
        }
    } catch {
        // ignore
    }

    return null;
}

export function getDefaultGeminiPath(): string {
    if (process.env.HAPI_GEMINI_PATH) {
        return process.env.HAPI_GEMINI_PATH;
    }

    if (process.platform === 'win32') {
        const windowsPath = findWindowsGeminiPath();
        if (!windowsPath) {
            throw new Error('Gemini CLI not found on PATH. Install Gemini CLI or set HAPI_GEMINI_PATH.');
        }
        return windowsPath;
    }

    const homeDir = homedir();
    const unixCandidates = [
        '/opt/homebrew/bin/gemini',
        '/usr/local/bin/gemini',
        '/usr/bin/gemini',
        join(homeDir, '.local', 'bin', 'gemini')
    ];

    for (const candidate of unixCandidates) {
        if (existsSync(candidate)) {
            logger.debug(`[Gemini] Found gemini at: ${candidate}`);
            return candidate;
        }
    }

    try {
        execSync('gemini --version', {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: homeDir
        });
        return 'gemini';
    } catch {
        // ignore
    }

    throw new Error('Gemini CLI not found on PATH. Install Gemini CLI or set HAPI_GEMINI_PATH.');
}
