import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execSync, readFileSync, spawnSync, sleep } = vi.hoisted(() => ({
    execSync: vi.fn(),
    readFileSync: vi.fn(),
    spawnSync: vi.fn(),
    sleep: vi.fn(),
}));

vi.mock('node:child_process', async importOriginal => ({
    ...await importOriginal<typeof import('node:child_process')>(),
    execSync,
}));
vi.mock('node:fs', async importOriginal => ({
    ...await importOriginal<typeof import('node:fs')>(),
    readFileSync,
}));
vi.mock('node:timers/promises', () => ({ setTimeout: sleep }));
vi.mock('cross-spawn', () => ({ default: { sync: spawnSync } }));

import { publishNpm } from './publish-npm';

const version = '1.2.3';
const root = '/mock/cli';
const linux = `@twsxtd/hapi-linux-x64@${version}`;
const darwin = `@twsxtd/hapi-darwin-arm64@${version}`;
const main = `@twsxtd/hapi@${version}`;
const visible = { status: 0, stdout: JSON.stringify(version) };
const npmError = (code: string) => ({ status: 1, stdout: JSON.stringify({ error: { code } }) });
const missing = npmError('E404');
const mainDir = join(root, 'npm', 'main');

describe('npm release visibility gate', () => {
    let now: number;

    beforeEach(() => {
        now = 0;
        vi.resetAllMocks();
        vi.stubEnv('NPM_PUBLISH_WAIT_TIMEOUT_SECONDS', '');
        readFileSync.mockReturnValue(JSON.stringify({ version }));
        sleep.mockImplementation(async (ms: number) => { now += ms; });
        vi.spyOn(performance, 'now').mockImplementation(() => now);
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    it('waits beyond the former 10-minute limit and publishes the main package as soon as all versions are visible', async () => {
        const queried = new Set<string>();
        spawnSync.mockImplementation((_exe, [, spec]) => {
            if (!queried.has(spec)) {
                queried.add(spec);
                return missing;
            }
            if (spec === linux && now < 12 * 60_000) return now === 0 ? npmError('E429') : missing;
            return visible;
        });
        execSync.mockImplementation((_command, { cwd }) => {
            if (cwd === mainDir) expect(now).toBe(12 * 60_000);
        });

        await publishNpm(root, false);

        expect(spawnSync).toHaveBeenCalledWith('npm', [
            'view', darwin, 'version', '--json', '--prefer-online',
            '--registry=https://registry.npmjs.org/', '--@twsxtd:registry=https://registry.npmjs.org/',
            '--fetch-retries=0', '--fetch-timeout=10000',
        ], expect.objectContaining({ timeout: 12_000, killSignal: 'SIGKILL' }));
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining('timeout: 1800s'));
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining(`${linux} (registry lookup failed: E429)`));
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining(`${linux} (not visible yet: E404)`));
        expect(spawnSync.mock.calls.filter(([, args]) => args[1] === darwin)).toHaveLength(2);
        expect(execSync).toHaveBeenCalledTimes(7); // package prep, five platform packages, main package
        expect(execSync).toHaveBeenLastCalledWith('npm publish --access public', expect.objectContaining({ cwd: mainDir }));
    });

    it('enforces the configured deadline, bounds its final queries, and leaves the main package unpublished', async () => {
        vi.stubEnv('NPM_PUBLISH_WAIT_TIMEOUT_SECONDS', '20');
        const checked = new Set<string>();
        spawnSync.mockImplementation((_exe, [, spec]) => {
            if (!checked.has(spec)) {
                checked.add(spec);
                return visible;
            }
            if (spec === linux) return missing;
            if (spec === darwin) return { error: Object.assign(new Error(), { code: 'ETIMEDOUT' }) };
            return visible;
        });

        const release = publishNpm(root, false);
        await expect(release).rejects.toThrow(new RegExp(
            'Timed out.*ETIMEDOUT.*E404.*The main package was NOT published',
        ));
        expect(now).toBe(20_000);
        expect(spawnSync).toHaveBeenLastCalledWith('npm', expect.arrayContaining(['--fetch-timeout=5000']),
            expect.objectContaining({ timeout: 5_000 }));
        expect(spawnSync.mock.calls.some(([, args]) => args[1] === main)).toBe(false);
        expect(execSync).toHaveBeenCalledTimes(1); // the five platform publishes were skipped
    });

    it('retries a transient preflight error without re-publishing versions that are already visible', async () => {
        spawnSync.mockReturnValue(visible)
            .mockReturnValueOnce({ status: 1, stderr: 'npm error code E503\n' });

        await publishNpm(root, false);

        expect(sleep).toHaveBeenCalledExactlyOnceWith(3_000);
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(`${darwin} failed (E503)`));
        expect(execSync).toHaveBeenCalledExactlyOnceWith('bun run prepare-npm-packages',
            expect.objectContaining({ cwd: root }));
    });

    it('does not publish when preflight cannot verify the version after three attempts', async () => {
        spawnSync.mockReturnValue(npmError('ECONNRESET'));

        await expect(publishNpm(root, false)).rejects.toThrow('after 3 attempts (ECONNRESET)');
        expect(spawnSync).toHaveBeenCalledTimes(3);
        expect(execSync).toHaveBeenCalledTimes(1);
    });

    it.each(['E401', 'E403', 'EINVALIDPROXY'])('fails immediately on a hard registry error: %s', async code => {
        for (let i = 0; i < 5; i++) spawnSync.mockReturnValueOnce(visible);
        spawnSync.mockReturnValueOnce(npmError(code));

        await expect(publishNpm(root, false)).rejects.toThrow(`npm view failed for ${darwin} (${code})`);
        expect(sleep).not.toHaveBeenCalled();
        expect(execSync).toHaveBeenCalledTimes(1);
    });

    it('rejects invalid timeout settings before performing any work', async () => {
        await expect(publishNpm(root, false, '0')).rejects.toThrow('must be a positive integer');
        expect(execSync).not.toHaveBeenCalled();
        expect(spawnSync).not.toHaveBeenCalled();
    });

    it('does not poll or actually publish in dry-run mode', async () => {
        spawnSync.mockReturnValue(missing);

        await publishNpm(root, true);

        expect(spawnSync).toHaveBeenCalledTimes(6);
        expect(sleep).not.toHaveBeenCalled();
        expect(execSync.mock.calls.slice(1).map(([cmd]) => cmd))
            .toEqual(Array(6).fill('npm publish --access public --dry-run'));
    });
});
