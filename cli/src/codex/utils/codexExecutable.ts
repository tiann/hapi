import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const windowsPath = path.win32;

export interface CodexCommand {
    command: string;
    args: string[];
}

function fallbackCodexBinDirs(): string[] {
    const home = homedir();
    const dirs = home
        ? [
            path.join(home, '.local', 'bin'),
            path.join(home, '.npm-global', 'bin'),
            path.join(home, '.bun', 'bin')
        ]
        : [];

    if (process.platform === 'darwin') {
        dirs.push('/opt/homebrew/bin', '/usr/local/bin');
    } else if (process.platform !== 'win32') {
        dirs.push('/usr/local/bin');
    }

    return dirs;
}

export function withCodexSpawnEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const existingPath = env.PATH ?? '';
    const existingDirs = new Set(existingPath.split(path.delimiter).filter(Boolean));
    const fallbackDirs = fallbackCodexBinDirs().filter((dir) => !existingDirs.has(dir));
    const nextPath = [existingPath, ...fallbackDirs].filter(Boolean).join(path.delimiter);

    if (nextPath === existingPath) {
        return env;
    }

    return {
        ...env,
        PATH: nextPath
    };
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

function pathContainsCommand(envPath: string, command: string): boolean {
    return envPath
        .split(path.delimiter)
        .filter(Boolean)
        .some((dir) => existsSync(path.join(dir, command)));
}

function resolvePosixCodexCommand(): CodexCommand {
    if (pathContainsCommand(process.env.PATH ?? '', 'codex')) {
        return { command: 'codex', args: [] };
    }

    const candidate = fallbackCodexBinDirs()
        .map((dir) => path.join(dir, 'codex'))
        .find((file) => existsSync(file));

    return { command: candidate ?? 'codex', args: [] };
}

export function resolveCodexCommand(): CodexCommand {
    if (process.platform !== 'win32') {
        return resolvePosixCodexCommand();
    }

    return resolveWindowsCodexCommand();
}
