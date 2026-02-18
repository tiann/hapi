import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '@/ui/logger';

function findWindowsCodexPath(): string | null {
    const homeDir = homedir();
    const candidates = [
        join(homeDir, '.local', 'bin', 'codex.exe'),
        join(homeDir, 'AppData', 'Local', 'Programs', 'codex', 'codex.exe')
    ];

    for (const candidate of candidates) {
        if (existsSync(candidate)) {
            logger.debug(`[Codex] Found Windows codex.exe at: ${candidate}`);
            return candidate;
        }
    }

    try {
        const result = execSync('where codex.exe', {
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

export function getDefaultCodexPath(): string {
    if (process.env.HAPI_CODEX_PATH) {
        return process.env.HAPI_CODEX_PATH;
    }

    if (process.platform === 'win32') {
        const windowsPath = findWindowsCodexPath();
        if (!windowsPath) {
            throw new Error('Codex CLI not found on PATH. Install Codex CLI or set HAPI_CODEX_PATH.');
        }
        return windowsPath;
    }

    const homeDir = homedir();
    const unixCandidates = [
        '/opt/homebrew/bin/codex',
        '/usr/local/bin/codex',
        '/usr/bin/codex',
        join(homeDir, '.local', 'bin', 'codex')
    ];

    for (const candidate of unixCandidates) {
        if (existsSync(candidate)) {
            logger.debug(`[Codex] Found codex at: ${candidate}`);
            return candidate;
        }
    }

    try {
        execSync('codex --version', {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: homeDir
        });
        return 'codex';
    } catch {
        // ignore
    }

    throw new Error('Codex CLI not found on PATH. Install Codex CLI or set HAPI_CODEX_PATH.');
}
