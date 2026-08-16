/**
 * Low-level ripgrep wrapper - just arguments in, string out
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { join, resolve } from 'path';
import { platform } from 'os';
import { matchesSearchQuery } from '@hapi/protocol';
import { runtimePath } from '@/projectPath';
import { withBunRuntimeEnv } from '@/utils/bunRuntime';

export interface RipgrepResult {
    exitCode: number
    stdout: string
    stderr: string
}

export interface RipgrepOptions {
    cwd?: string
}

export interface FileSearchOptions {
    cwd?: string
    query: string
    limit: number
}

function getBinaryPath(): string {
    const platformName = platform();
    const binaryName = platformName === 'win32' ? 'rg.exe' : 'rg';
    return resolve(join(runtimePath(), 'tools', 'unpacked', binaryName));
}

export function run(args: string[], options?: RipgrepOptions): Promise<RipgrepResult> {
    const binaryPath = getBinaryPath();
    return new Promise((resolve, reject) => {
        const child = spawn(binaryPath, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: options?.cwd,
            env: withBunRuntimeEnv(),
            windowsHide: process.platform === 'win32'
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        child.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        child.on('close', (code) => {
            resolve({
                exitCode: code || 0,
                stdout,
                stderr
            });
        });

        child.on('error', (err) => {
            reject(err);
        });
    });
}

export function matchesFileSearchPath(path: string, query: string): boolean {
    const normalizedPath = platform() === 'win32' ? path.replaceAll('\\', '/') : path
    return matchesSearchQuery(normalizedPath, query)
}

export function selectFileSearchPaths(paths: Iterable<string>, query: string, limit: number): string[] {
    const matches: string[] = []
    const boundedLimit = Math.max(1, limit)
    for (const path of paths) {
        if (matchesFileSearchPath(path, query)) {
            matches.push(path)
            if (matches.length >= boundedLimit) break
        }
    }
    return matches
}

export function runFileSearch(args: string[], options: FileSearchOptions): Promise<RipgrepResult> {
    const binaryPath = getBinaryPath();
    const limit = Math.max(1, options.limit)
    return new Promise((resolve, reject) => {
        const child = spawn(binaryPath, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: options.cwd,
            env: withBunRuntimeEnv(),
            windowsHide: process.platform === 'win32'
        });

        const lines = createInterface({ input: child.stdout });
        const matchedPaths: string[] = [];
        let stderr = '';
        let settled = false;

        child.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        lines.on('line', (line) => {
            if (matchedPaths.length >= limit) return;
            if (matchesFileSearchPath(line, options.query)) {
                matchedPaths.push(line);
                if (matchedPaths.length >= limit) {
                    child.kill();
                }
            }
        });

        child.on('close', (code) => {
            if (settled) return;
            settled = true;
            lines.close();
            resolve({
                exitCode: code || 0,
                stdout: matchedPaths.length > 0 ? `${matchedPaths.join('\n')}\n` : '',
                stderr
            });
        });

        child.on('error', (err) => {
            if (settled) return;
            settled = true;
            lines.close();
            reject(err);
        });
    });
}
