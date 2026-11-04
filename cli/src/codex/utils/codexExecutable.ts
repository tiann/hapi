import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { resolveExecutable } from '@/agent/agentLaunchCommand';

const windowsPath = path.win32;

export interface CodexCommand {
    command: string;
    args: string[];
}

function findWhereResults(command: string): string[] {
    try {
        const result = execFileSync('where.exe', [command], {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: homedir(),
            windowsHide: process.platform === 'win32'
        });

        return result
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
    } catch {
        return [];
    }
}

function resolveShimScript(shimPath: string): string | null {
    const shimDirectory = windowsPath.dirname(shimPath);
    const script = windowsPath.join(shimDirectory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');

    if (existsSync(script)) {
        return script;
    }

    return null;
}

function resolveWindowsCandidate(candidate: string): CodexCommand | null {
    if (!existsSync(candidate)) {
        return null;
    }

    if (windowsPath.extname(candidate).toLowerCase() === '.exe') {
        return { command: candidate, args: [] };
    }

    const script = resolveShimScript(candidate);
    if (script) {
        return { command: 'node', args: [script] };
    }

    return null;
}

function resolveWindowsCodexCommand(): CodexCommand {
    for (const candidate of findWhereResults('codex')) {
        const resolved = resolveWindowsCandidate(candidate);
        if (resolved) {
            return resolved;
        }
    }

    return { command: 'codex', args: [] };
}

/** Resolve a selected app-server executable without passing JSON overrides through cmd.exe. */
export function resolveSelectedCodexCommand(command: string, platform: NodeJS.Platform = process.platform): CodexCommand {
    if (platform !== 'win32') return { command, args: [] };
    if (command === 'codex') return resolveWindowsCodexCommand();
    const candidates = windowsPath.basename(command) === command ? findWhereResults(command) : [];
    for (const candidate of [...candidates, command]) {
        const resolved = resolveWindowsCandidate(candidate);
        if (resolved) return resolved;
    }
    if (/\.(cmd|bat)$/i.test(command)) {
        throw new Error('Use a Codex executable or an npm Codex shim with its launcher script on Windows.');
    }
    return { command, args: [] };
}

export const MACOS_CODEX_APP_COMMAND = '/Applications/Codex.app/Contents/Resources/codex';

export function resolveCodexCommand(
    env: Record<string, string | undefined> = process.env,
    platform: NodeJS.Platform = process.platform,
): CodexCommand {
    if (platform !== 'win32') {
        const command = resolveExecutable('codex', {
            platform,
            pathValue: env.PATH,
            pathExt: env.PATHEXT,
        });
        if (command) return { command, args: [] };
        if (platform === 'darwin' && existsSync(MACOS_CODEX_APP_COMMAND)) {
            return { command: MACOS_CODEX_APP_COMMAND, args: [] };
        }
        return { command: 'codex', args: [] };
    }

    return resolveWindowsCodexCommand();
}
