import { describe, expect, it } from 'bun:test';
import { TUNWG_LICENSE, TUNWG_VERSION, selectTunwgReleases } from './tunwgTargets';

describe('selectTunwgReleases', () => {
    it('selects only the current host artifact for a host build', () => {
        expect(selectTunwgReleases(['--host'], 'darwin', 'arm64')).toEqual([
            ['arm64-darwin', {
                url: 'https://github.com/tiann/tunwg/releases/download/v26.01.13%2B359bfa2/tunwg-darwin-arm64',
                sha256: '70c90b59e1aded850cf3b77d5eb6145302a17a91e7267e2d12a5a675fa1784cd',
            }],
        ]);
        expect(selectTunwgReleases(['--host'], 'linux', 'x64')).toEqual([
            ['x64-linux', {
                url: 'https://github.com/tiann/tunwg/releases/download/v26.01.13%2B359bfa2/tunwg',
                sha256: 'a61c96c0b11e28cfc1904ad04779670e90133bae4e9bd17b979dad7de8319238',
            }],
        ]);
    });

    it('keeps all release artifacts for cross-platform release builds', () => {
        const releases = selectTunwgReleases([], 'darwin', 'arm64');
        expect(releases).toEqual([
            ['x64-linux', {
                url: 'https://github.com/tiann/tunwg/releases/download/v26.01.13%2B359bfa2/tunwg',
                sha256: 'a61c96c0b11e28cfc1904ad04779670e90133bae4e9bd17b979dad7de8319238',
            }],
            ['arm64-linux', {
                url: 'https://github.com/tiann/tunwg/releases/download/v26.01.13%2B359bfa2/tunwg-arm64',
                sha256: '19be6977f84acb5a4ceac96deb829f967a188b7975fa67f2d174acf745d70891',
            }],
            ['x64-darwin', {
                url: 'https://github.com/tiann/tunwg/releases/download/v26.01.13%2B359bfa2/tunwg-darwin',
                sha256: 'e226d325b4fadf43ee7138168b84da239e35c8ed82d4a87f0745f0769ae6b222',
            }],
            ['arm64-darwin', {
                url: 'https://github.com/tiann/tunwg/releases/download/v26.01.13%2B359bfa2/tunwg-darwin-arm64',
                sha256: '70c90b59e1aded850cf3b77d5eb6145302a17a91e7267e2d12a5a675fa1784cd',
            }],
            ['x64-win32', {
                url: 'https://github.com/tiann/tunwg/releases/download/v26.01.13%2B359bfa2/tunwg.exe',
                sha256: 'dd52d035139e27402eadff761dbd1dda70c161551ae2eafcbc3ca0afa77b6f21',
            }],
        ]);
        expect(TUNWG_VERSION).toBe('v26.01.13+359bfa2');
        for (const [, release] of releases) {
            expect(release.url).toContain('/releases/download/v26.01.13%2B359bfa2/');
            expect(release.url).not.toContain('/latest/');
            expect(release.sha256).toMatch(/^[a-f0-9]{64}$/);
        }
        expect(TUNWG_LICENSE).toEqual({
            url: 'https://raw.githubusercontent.com/tiann/tunwg/v26.01.13%2B359bfa2/LICENSE',
            sha256: 'd8ac11fb1304443975a04293266bc30227d0dbf01a44f9d51d9ece096aadbe36',
        });
    });

    it('rejects unsupported host targets instead of silently downloading everything', () => {
        expect(() => selectTunwgReleases(['--host'], 'freebsd', 'x64')).toThrow(/unsupported host/i);
        expect(() => selectTunwgReleases(['--host'], 'darwin', 'ia32')).toThrow(/unsupported host/i);
    });

    it('selects the existing Windows x64 artifact without falling back to another target', () => {
        expect(selectTunwgReleases(['--host'], 'win32', 'x64')).toEqual([
            ['x64-win32', {
                url: 'https://github.com/tiann/tunwg/releases/download/v26.01.13%2B359bfa2/tunwg.exe',
                sha256: 'dd52d035139e27402eadff761dbd1dda70c161551ae2eafcbc3ca0afa77b6f21',
            }],
        ]);
    });
});
