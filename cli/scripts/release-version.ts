import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Update release versions without changing native build numbers or Gradle overrides. */
export function updateReleaseVersions(repoRoot: string, version: string, dryRun = false): string {
    const pkgPath = join(repoRoot, 'cli', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const oldVersion: string = pkg.version;
    pkg.version = version;

    function updateVersionFile(relativePath: string, pattern: RegExp): { path: string; content: string } {
        const path = join(repoRoot, relativePath);
        const content = readFileSync(path, 'utf-8');
        let matched = false;
        const updated = content.replace(pattern, (_match, prefix: string, suffix: string) => {
            matched = true;
            return `${prefix}${version}${suffix}`;
        });
        // An already-current version is valid (e.g. when retrying a release).
        if (!matched) {
            throw new Error(`Could not find release version in ${relativePath}`);
        }
        return { path, content: updated };
    }

    // Read and validate every version field before writing any files.
    const updates = [
        { path: pkgPath, content: JSON.stringify(pkg, null, 2) + '\n' },
        updateVersionFile(
            'shared/src/buildInfo.ts',
            /(export const APP_VERSION = ['"])[^'"\r\n]+(['"])/
        ),
        // Includes Debug/Release for both Hapi and HapiNotificationService.
        updateVersionFile(
            'ios/Hapi.xcodeproj/project.pbxproj',
            /^([ \t]*MARKETING_VERSION\s*=\s*)[^;\r\n]+(;)/gm
        ),
        updateVersionFile(
            'android/app/build.gradle.kts',
            /(versionName\s*=\s*providers\.gradleProperty\("hapiVersionName"\)\.orElse\(")[^"]+("\))/
        ),
    ];

    if (!dryRun) {
        for (const update of updates) {
            writeFileSync(update.path, update.content);
        }
    }
    return oldVersion;
}
