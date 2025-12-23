/**
 * Low-level ripgrep wrapper - just arguments in, string out
 */

import { spawn } from 'child_process';
import { join, resolve } from 'path';
import { platform } from 'os';
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
            env: withBunRuntimeEnv()
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
