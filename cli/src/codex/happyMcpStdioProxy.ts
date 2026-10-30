/**
 * HAPI-owned stdio-to-stdio proxy for external Codex MCP servers.
 *
 * This command is intentionally internal. It lets the compiled HAPI binary
 * bridge Windows command shims without requiring a separate Node runtime.
 */

import { execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import spawn from 'cross-spawn';

type StdioProxySpec = {
    command: string;
    args: string[];
    cwd?: string;
};

function parseSpecPath(argv: string[]): string | null {
    const index = argv.indexOf('--spec');
    const value = index >= 0 ? argv[index + 1] : undefined;
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function parseSpec(value: unknown): StdioProxySpec {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('MCP proxy spec must be an object');
    }

    const record = value as Record<string, unknown>;
    if (typeof record.command !== 'string' || record.command.trim().length === 0) {
        throw new Error('MCP proxy spec command must be a non-empty string');
    }
    if (!Array.isArray(record.args) || record.args.some((arg) => typeof arg !== 'string')) {
        throw new Error('MCP proxy spec args must be an array of strings');
    }
    if (record.cwd !== undefined && typeof record.cwd !== 'string') {
        throw new Error('MCP proxy spec cwd must be a string');
    }

    return {
        command: record.command,
        args: record.args,
        ...(typeof record.cwd === 'string' ? { cwd: record.cwd } : {})
    };
}

function resolveWindowsCommand(command: string): string {
    if (process.platform !== 'win32' || /[\\/]/.test(command) || /\.(exe|cmd|bat)$/i.test(command)) {
        return command;
    }

    try {
        const entries = execFileSync('where.exe', [command], {
            encoding: 'utf8',
            windowsHide: true
        })
            .split(/\r?\n/)
            .map((entry) => entry.trim())
            .filter(Boolean);
        return entries.find((entry) => /\.(exe|cmd|bat)$/i.test(entry)) ?? entries[0] ?? command;
    } catch {
        return command;
    }
}

export async function runHappyMcpStdioProxy(argv: string[]): Promise<void> {
    const specPath = parseSpecPath(argv);
    if (!specPath) {
        process.stderr.write('[hapi-mcp-proxy] Missing --spec path\n');
        process.exitCode = 2;
        return;
    }

    const pendingInput: Buffer[] = [];
    let child: ChildProcessWithoutNullStreams | null = null;
    let childReady = false;
    let inputEnded = false;
    let settled = false;

    const forwardInput = (chunk: Buffer | Uint8Array) => {
        const data = Buffer.from(chunk);
        if (!child || !childReady) {
            pendingInput.push(data);
            return;
        }
        if (!child.stdin.destroyed && !child.stdin.writableEnded) {
            child.stdin.write(data);
        }
    };
    const endChildInput = () => {
        inputEnded = true;
        if (childReady && child && !child.stdin.destroyed && !child.stdin.writableEnded) {
            child.stdin.end();
        }
    };
    const forwardSignal = () => {
        if (child && !child.killed) {
            child.kill();
        }
    };

    process.stdin.on('data', forwardInput);
    process.stdin.on('end', endChildInput);
    process.once('SIGTERM', forwardSignal);
    process.once('SIGINT', forwardSignal);

    try {
        const spec = parseSpec(JSON.parse(await readFile(specPath, 'utf8')));
        const command = resolveWindowsCommand(spec.command);
        child = spawn(command, spec.args, {
            cwd: spec.cwd ?? process.cwd(),
            env: { ...process.env },
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: process.platform === 'win32'
        }) as unknown as ChildProcessWithoutNullStreams;

        child.stdout.on('data', (chunk) => process.stdout.write(chunk));
        child.stderr.on('data', (chunk) => process.stderr.write(chunk));
        child.once('spawn', () => {
            childReady = true;
            for (const chunk of pendingInput) {
                forwardInput(chunk);
            }
            pendingInput.length = 0;
            if (inputEnded) {
                endChildInput();
            }
        });

        await new Promise<void>((resolve) => {
            const finish = (code: number) => {
                if (settled) {
                    return;
                }
                settled = true;
                process.exitCode = code;
                resolve();
            };
            child?.once('error', (error) => {
                process.stderr.write(`[hapi-mcp-proxy] ${error.message}\n`);
                finish(1);
            });
            child?.once('close', (code) => finish(typeof code === 'number' ? code : 1));
        });
    } catch (error) {
        process.stderr.write(`[hapi-mcp-proxy] ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    } finally {
        process.stdin.off('data', forwardInput);
        process.stdin.off('end', endChildInput);
        process.off('SIGTERM', forwardSignal);
        process.off('SIGINT', forwardSignal);
        process.stdin.pause();
    }
}
