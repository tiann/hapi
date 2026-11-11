import { spawn } from 'node:child_process';
import { getAgentLaunchCommand } from '@/agent/agentLaunchCommand';

export const AGY_ACP_MIN_VERSION: readonly [number, number, number] = [1, 5, 0];

const VERSION_PROBE_TIMEOUT_MS = 10_000;
// A background child can hold stdout open after agy exits.
const STDOUT_GRACE_AFTER_EXIT_MS = 500;

export type AgyVersionProbe = () => Promise<string>;

export function probeAgyVersion(
    command: string = getAgentLaunchCommand('agy'),
    timeoutMs: number = VERSION_PROBE_TIMEOUT_MS
): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, ['--version'], {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: process.platform === 'win32',
        });
        let output = '';
        let settled = false;
        let graceTimer: ReturnType<typeof setTimeout> | null = null;
        const settle = (fn: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (graceTimer) clearTimeout(graceTimer);
            fn();
        };
        const timer = setTimeout(() => settle(() => {
            child.kill('SIGTERM');
            reject(new Error(`agy --version did not answer within ${timeoutMs} ms`));
        }), timeoutMs);
        // Only stdout carries the version; stderr may hold notices with other
        // version numbers.
        child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        child.on('error', (error) => settle(() => reject(error)));
        const finish = (code: number | null) => settle(() => {
            if (code === 0) resolve(output);
            else reject(new Error(`agy --version exited with code ${code}`));
        });
        child.on('close', finish);
        child.on('exit', (code) => {
            graceTimer = setTimeout(() => finish(code), STDOUT_GRACE_AFTER_EXIT_MS);
        });
    });
}

type AgyVersion = { core: [number, number, number]; prerelease: boolean };

export function parseAgyVersion(output: string): AgyVersion | null {
    const match = /(?<![\w.])v?(\d+)\.(\d+)(?:\.(\d+))?(-[0-9A-Za-z.-]+)?/.exec(output);
    if (!match) return null;
    return {
        core: [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)],
        prerelease: Boolean(match[4]),
    };
}

function isBefore(version: AgyVersion, floor: readonly number[]): boolean {
    for (let i = 0; i < floor.length; i += 1) {
        if (version.core[i] !== floor[i]) return version.core[i]! < floor[i]!;
    }
    // Same core: a pre-release sorts before the release (semver).
    return version.prerelease;
}

/**
 * An unreadable version means stream-json: it works on every agy release HAPI
 * supports, `agy acp` only on 1.5.0 and newer.
 */
export async function needsStreamJson(probe: AgyVersionProbe = () => probeAgyVersion()): Promise<{ streamJson: boolean; reason: string }> {
    let output: string;
    try {
        output = await probe();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { streamJson: true, reason: `could not read the agy version (${message})` };
    }
    const version = parseAgyVersion(output);
    if (!version) {
        return { streamJson: true, reason: `could not read the agy version from "${output.trim().slice(0, 80)}"` };
    }
    const label = output.trim().split(/\s+/).find((word) => /\d+\.\d+/.test(word)) ?? version.core.join('.');
    if (isBefore(version, AGY_ACP_MIN_VERSION)) {
        return { streamJson: true, reason: `agy ${label} predates agy acp (${AGY_ACP_MIN_VERSION.join('.')})` };
    }
    return { streamJson: false, reason: `agy ${label} supports agy acp` };
}
