import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { updateReleaseVersions } from './release-version';

const sourceRoot = fileURLToPath(new URL('../..', import.meta.url));
const paths = {
    cli: 'cli/package.json',
    shared: 'shared/src/buildInfo.ts',
    ios: 'ios/Hapi.xcodeproj/project.pbxproj',
    android: 'android/app/build.gradle.kts',
};

describe('updateReleaseVersions', () => {
    let repoRoot: string;

    function read(path: string): string {
        return readFileSync(join(repoRoot, path), 'utf-8');
    }

    function write(path: string, content: string): void {
        writeFileSync(join(repoRoot, path), content);
    }

    function snapshot(): string[] {
        return Object.values(paths).map(read);
    }

    beforeEach(() => {
        repoRoot = mkdtempSync(join(tmpdir(), 'hapi-release-version-'));
        // Exercise the real project formats without ever modifying the checkout.
        for (const path of Object.values(paths)) {
            mkdirSync(dirname(join(repoRoot, path)), { recursive: true });
            write(path, readFileSync(join(sourceRoot, path), 'utf-8'));
        }
    });

    afterEach(() => {
        rmSync(repoRoot, { recursive: true, force: true });
    });

    it('updates every release version while preserving other settings and native build numbers', () => {
        const pkg = JSON.parse(read(paths.cli));
        const shared = read(paths.shared);
        const ios = read(paths.ios);
        const android = read(paths.android);

        expect(updateReleaseVersions(repoRoot, '1.2.3')).toBe(pkg.version);

        expect(JSON.parse(read(paths.cli))).toEqual({ ...pkg, version: '1.2.3' });
        expect(read(paths.shared)).toBe(shared.replace(/APP_VERSION = ['"][^'"]+['"]/, "APP_VERSION = '1.2.3'"));
        expect(read(paths.ios)).toBe(ios.replace(/MARKETING_VERSION = [^;]+;/g, 'MARKETING_VERSION = 1.2.3;'));
        // Both app and extension, Debug and Release, must stay in sync.
        expect([...read(paths.ios).matchAll(/MARKETING_VERSION = ([^;]+);/g)].map(match => match[1]))
            .toEqual(['1.2.3', '1.2.3', '1.2.3', '1.2.3']);
        expect(read(paths.android)).toBe(android.replace(
            /versionName = .*/,
            'versionName = providers.gradleProperty("hapiVersionName").orElse("1.2.3").get()'
        ));
    });

    it('does not change any files in dry-run mode', () => {
        const before = snapshot();

        expect(updateReleaseVersions(repoRoot, '1.2.3', true)).toBe(JSON.parse(read(paths.cli)).version);

        expect(snapshot()).toEqual(before);
    });

    it('can retry the same version without failing or changing build numbers', () => {
        updateReleaseVersions(repoRoot, '1.2.3');
        const before = snapshot();

        expect(updateReleaseVersions(repoRoot, '1.2.3')).toBe('1.2.3');

        expect(snapshot()).toEqual(before);
    });

    it('repairs stale native versions even when CLI and shared versions are already current', () => {
        updateReleaseVersions(repoRoot, '1.2.3');
        const expected = snapshot();
        write(paths.ios, read(paths.ios).replaceAll('MARKETING_VERSION = 1.2.3;', 'MARKETING_VERSION = 0.0.1;'));
        write(paths.android, read(paths.android).replace('orElse("1.2.3")', 'orElse("0.0.1")'));

        expect(updateReleaseVersions(repoRoot, '1.2.3')).toBe('1.2.3');

        expect(snapshot()).toEqual(expected);
    });

    describe.each([false, true])('validation (dryRun: %s)', dryRun => {
        it.each([
            [paths.shared, 'APP_VERSION'],
            [paths.ios, 'MARKETING_VERSION'],
            [paths.android, 'hapiVersionName'],
        ])('rejects a missing version field in %s before writing any files', (path, field) => {
            write(path, read(path).replaceAll(field, 'REMOVED_VERSION_FIELD'));
            const before = snapshot();

            expect(() => updateReleaseVersions(repoRoot, '1.2.3', dryRun)).toThrow(path);

            expect(snapshot()).toEqual(before);
        });
    });
});
