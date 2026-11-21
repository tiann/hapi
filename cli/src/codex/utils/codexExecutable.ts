import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { resolveExecutable } from '@/agent/agentLaunchCommand';

const windowsPath = path.win32;

export interface CodexCommand {
    command: string;
    args: string[];
}

export type CodexCliVersion = [number, number, number];

export function parseCodexCliVersion(stdout: string): CodexCliVersion | null {
    const version = stdout.match(/codex-cli (\d+)\.(\d+)\.(\d+)/);
    return version ? [Number(version[1]), Number(version[2]), Number(version[3])] : null;
}

function readCodexCliVersion(command: CodexCommand, cwd?: string): Promise<CodexCliVersion | null> {
    return new Promise(resolve => {
        execFile(command.command, [...command.args, '--version'], {
            cwd, encoding: 'utf8', timeout: 3_000, windowsHide: process.platform === 'win32'
        }, (error, stdout) => resolve(error ? null : parseCodexCliVersion(stdout)));
    });
}

const codexVersions = new Map<string, { identity: string; version: Promise<CodexCliVersion | null> }>();

async function isNativeExecutable(command: string): Promise<boolean> {
    const file = await open(command, 'r');
    try {
        const header = Buffer.alloc(4);
        if ((await file.read(header, 0, header.length, 0)).bytesRead !== header.length) return false;
        const magic = header.readUInt32BE();
        return header.readUInt16BE() === 0x4d5a // PE
            || magic === 0x7f454c46 // ELF
            || [0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic); // Mach-O
    } finally {
        await file.close();
    }
}

export async function probeCodexCliVersion(command: CodexCommand, cwd?: string): Promise<CodexCliVersion | null> {
    if (command.args.length > 0 || !path.isAbsolute(command.command)) return readCodexCliVersion(command, cwd);
    const file = await stat(command.command).catch(() => null);
    if (!file?.isFile()) return readCodexCliVersion(command, cwd);

    const identity = JSON.stringify([file.dev, file.ino, file.size, file.mtimeMs, file.ctimeMs]);
    const cached = codexVersions.get(command.command);
    if (cached?.identity === identity) return cached.version;

    // Launchers can upgrade the executable they delegate to without changing their own file.
    if (!await isNativeExecutable(command.command).catch(() => false)) return readCodexCliVersion(command, cwd);
    const existing = codexVersions.get(command.command);
    if (existing?.identity === identity) return existing.version;
    const version = readCodexCliVersion(command, cwd).then(result => {
        if (!result && codexVersions.get(command.command)?.version === version) codexVersions.delete(command.command);
        return result;
    });
    codexVersions.set(command.command, { identity, version });
    return version;
}

function parseWhereResults(stdout: string): string[] {
    return stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function findWhereResults(command: string): string[] {
    try {
        const result = execFileSync('where.exe', [command], {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: homedir(), timeout: 3_000,
            windowsHide: process.platform === 'win32'
        });

        return parseWhereResults(result);
    } catch {
        return [];
    }
}

function locateWindowsCandidates(command: string): Promise<string[]> {
    return new Promise(resolve => {
        execFile('where.exe', [command], {
            cwd: homedir(), encoding: 'utf8', timeout: 3_000, windowsHide: true
        }, (error, stdout) => resolve(error ? [] : parseWhereResults(stdout)));
    });
}

function windowsLaunchCommand(candidate: string): CodexCommand {
    if (windowsPath.extname(candidate).toLowerCase() === '.exe') return { command: candidate, args: [] };
    const script = windowsPath.join(windowsPath.dirname(candidate), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    return { command: 'node', args: [script] };
}

async function windowsCandidateExists(file: string): Promise<boolean> {
    return (await stat(file).catch(() => null))?.isFile() === true;
}

function resolveWindowsCodexCommand(): CodexCommand {
    for (const candidate of findWhereResults('codex')) {
        const launch = windowsLaunchCommand(candidate);
        if (existsSync(candidate) && launch.args.every(file => existsSync(file))) return launch;
    }

    return { command: 'codex', args: [] };
}

/** Resolve a selected app-server executable without passing JSON overrides through cmd.exe. */
export async function resolveSelectedCodexCommand(command: string, platform: NodeJS.Platform = process.platform): Promise<CodexCommand> {
    if (platform !== 'win32') return { command, args: [] };
    const candidates = windowsPath.basename(command) === command ? await locateWindowsCandidates(command) : [];
    for (const candidate of command === 'codex' ? candidates : [...candidates, command]) {
        const launch = windowsLaunchCommand(candidate);
        if ((await Promise.all([candidate, ...launch.args].map(windowsCandidateExists))).every(Boolean)) return launch;
    }
    if (/\.(cmd|bat)$/i.test(command)) {
        throw new Error('Use a Codex executable or an npm Codex shim with its launcher script on Windows.');
    }
    return { command, args: [] };
}

export async function resolveCatalogRunnerCommand(): Promise<CodexCommand> {
    return process.platform === 'win32' ? resolveSelectedCodexCommand('codex') : resolveCodexCommand();
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
