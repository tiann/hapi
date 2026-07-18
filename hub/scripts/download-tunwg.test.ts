import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    getTunwgArtifactFilename,
    getTunwgToolsDir,
    installVerifiedArtifact,
} from './download-tunwg';

const homes: string[] = [];

function sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

async function tempHome(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'hapi tunwg test '));
    homes.push(home);
    return home;
}

afterEach(async () => {
    await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe('getTunwgToolsDir', () => {
    it('decodes file URLs so checkout paths containing spaces remain valid', async () => {
        const home = await tempHome();
        const scriptPath = join(home, 'repo with spaces', 'hub', 'scripts', 'download-tunwg.ts');
        expect(getTunwgToolsDir(pathToFileURL(scriptPath).href)).toBe(
            join(home, 'repo with spaces', 'hub', 'tools', 'tunwg'),
        );
    });

    it('preserves every embedded runtime filename', () => {
        expect([
            'x64-linux',
            'arm64-linux',
            'x64-darwin',
            'arm64-darwin',
            'x64-win32',
        ].map(getTunwgArtifactFilename)).toEqual([
            'tunwg-x64-linux',
            'tunwg-arm64-linux',
            'tunwg-x64-darwin',
            'tunwg-arm64-darwin',
            'tunwg-x64-win32.exe',
        ]);
    });
});

describe('installVerifiedArtifact', () => {
    it('reuses an existing artifact only when its checksum matches', async () => {
        const home = await tempHome();
        const destPath = join(home, 'tunwg');
        await writeFile(destPath, 'verified');

        const result = await installVerifiedArtifact({
            url: 'https://example.invalid/tunwg',
            sha256: sha256('verified'),
            destPath,
            executable: true,
            fetchImpl: async () => {
                throw new Error('matching artifacts must not be downloaded again');
            },
            log: () => undefined,
        });

        expect(result).toBe('reused');
        expect(await readFile(destPath, 'utf8')).toBe('verified');
    });

    it('atomically replaces a stale existing artifact after verifying the new bytes', async () => {
        const home = await tempHome();
        const destPath = join(home, 'nested path with spaces', 'tunwg');
        await mkdir(join(home, 'nested path with spaces'), { recursive: true });
        await writeFile(destPath, 'stale');

        const result = await installVerifiedArtifact({
            url: 'https://example.invalid/tunwg',
            sha256: sha256('fresh'),
            destPath,
            executable: true,
            fetchImpl: async () => new Response('fresh'),
            log: () => undefined,
        });

        expect(result).toBe('installed');
        expect(await readFile(destPath, 'utf8')).toBe('fresh');
        expect((await readdir(join(home, 'nested path with spaces'))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });

    it('rejects a checksum mismatch without overwriting the existing artifact', async () => {
        const home = await tempHome();
        const destPath = join(home, 'tunwg');
        await writeFile(destPath, 'keep-existing');

        await expect(installVerifiedArtifact({
            url: 'https://example.invalid/tunwg',
            sha256: sha256('expected'),
            destPath,
            executable: true,
            fetchImpl: async () => new Response('tampered'),
            log: () => undefined,
        })).rejects.toThrow(/checksum mismatch.*expected.*actual/i);

        expect(await readFile(destPath, 'utf8')).toBe('keep-existing');
        expect((await readdir(home)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });

    it('leaves the existing artifact untouched when the network request fails', async () => {
        const home = await tempHome();
        const destPath = join(home, 'tunwg');
        await writeFile(destPath, 'keep-existing');

        await expect(installVerifiedArtifact({
            url: 'https://example.invalid/tunwg',
            sha256: sha256('fresh'),
            destPath,
            executable: true,
            fetchImpl: async () => {
                throw new Error('network unavailable');
            },
            log: () => undefined,
        })).rejects.toThrow(/network unavailable/);

        expect(await readFile(destPath, 'utf8')).toBe('keep-existing');
        expect((await readdir(home)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });

    it('keeps the existing artifact and removes the verified temp file when rename fails', async () => {
        const home = await tempHome();
        const destPath = join(home, 'tunwg');
        await writeFile(destPath, 'keep-existing');

        await expect(installVerifiedArtifact({
            url: 'https://example.invalid/tunwg',
            sha256: sha256('fresh'),
            destPath,
            executable: true,
            fetchImpl: async () => new Response('fresh'),
            renameImpl: async () => {
                throw Object.assign(new Error('rename denied'), { code: 'EPERM' });
            },
            log: () => undefined,
        })).rejects.toThrow(/rename denied/);

        expect(await readFile(destPath, 'utf8')).toBe('keep-existing');
        expect((await readdir(home)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });
});
