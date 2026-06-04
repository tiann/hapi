import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

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

export function resolveCodexCommand(): CodexCommand {
    if (process.platform !== 'win32') {
        return { command: 'codex', args: [] };
    }

    return resolveWindowsCodexCommand();
}
