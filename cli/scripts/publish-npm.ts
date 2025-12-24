/**
 * Publish all npm packages (platform packages + main package).
 *
 * Usage:
 *   bun run scripts/publish-npm.ts           # Publish all packages
 *   bun run scripts/publish-npm.ts --dry-run # Preview without publishing
 *   bun run scripts/publish-npm.ts --skip-build # Skip building binaries
 *
 * Prerequisites:
 *   - npm login (must be logged in to npm)
 *   - For scoped packages: npm access must be set to public
 */

import { execSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const repoRoot = join(projectRoot, '..');

const PLATFORMS = [
    'darwin-arm64',
    'darwin-x64',
    'linux-arm64',
    'linux-x64',
    'win32-x64'
];

function parseArgs(): { dryRun: boolean; skipBuild: boolean } {
    const args = process.argv.slice(2);
    return {
        dryRun: args.includes('--dry-run'),
        skipBuild: args.includes('--skip-build')
    };
}

function run(cmd: string, cwd: string = projectRoot): void {
    console.log(`\n$ ${cmd}`);
    execSync(cmd, { cwd, stdio: 'inherit' });
}

function checkNpmLogin(): boolean {
    try {
        const result = spawnSync('npm', ['whoami'], { encoding: 'utf-8' });
        if (result.status === 0) {
            console.log(`Logged in as: ${result.stdout.trim()}`);
            return true;
        }
    } catch {
        // ignore
    }
    return false;
}

function checkBinariesExist(): boolean {
    const binaries = [
        join(projectRoot, 'dist-exe', 'bun-darwin-arm64', 'hapi'),
        join(projectRoot, 'dist-exe', 'bun-darwin-x64', 'hapi'),
        join(projectRoot, 'dist-exe', 'bun-linux-arm64', 'hapi'),
        join(projectRoot, 'dist-exe', 'bun-linux-x64', 'hapi'),
        join(projectRoot, 'dist-exe', 'bun-windows-x64', 'hapi.exe')
    ];

    for (const bin of binaries) {
        if (!existsSync(bin)) {
            return false;
        }
    }
    return true;
}

function publishPackage(pkgDir: string, dryRun: boolean): void {
    const cmd = dryRun
        ? 'npm publish --access public --dry-run'
        : 'npm publish --access public';
    run(cmd, pkgDir);
}

async function main(): Promise<void> {
    const { dryRun, skipBuild } = parseArgs();

    console.log('='.repeat(60));
    console.log(dryRun ? '  DRY RUN - No packages will be published' : '  PUBLISHING PACKAGES');
    console.log('='.repeat(60));

    // Check npm login
    console.log('\n[1/5] Checking npm login...');
    if (!checkNpmLogin()) {
        console.error('Error: Not logged in to npm. Run `npm login` first.');
        process.exit(1);
    }

    // Build binaries (includes web assets)
    if (!skipBuild) {
        console.log('\n[2/5] Building binaries for all platforms (with web assets)...');
        run('bun run build:single-exe:all', repoRoot);
    } else {
        console.log('\n[2/5] Skipping build (--skip-build)');
        if (!checkBinariesExist()) {
            console.error('Error: Binaries not found. Run without --skip-build first.');
            process.exit(1);
        }
    }

    // Prepare npm packages
    console.log('\n[3/5] Preparing npm packages...');
    run('bun run prepare-npm-packages');

    // Publish platform packages
    console.log('\n[4/5] Publishing platform packages...');
    for (const platform of PLATFORMS) {
        const pkgDir = join(projectRoot, 'npm', platform);
        console.log(`\nPublishing @twsxtd/hapi-${platform}...`);
        try {
            publishPackage(pkgDir, dryRun);
        } catch (error) {
            console.error(`Failed to publish @twsxtd/hapi-${platform}`);
            throw error;
        }
    }

    // Publish main package
    console.log('\n[5/5] Publishing main package...');
    console.log('\nPublishing @twsxtd/hapi...');
    publishPackage(projectRoot, dryRun);

    console.log('\n' + '='.repeat(60));
    console.log(dryRun ? '  DRY RUN COMPLETE' : '  ALL PACKAGES PUBLISHED SUCCESSFULLY');
    console.log('='.repeat(60));

    if (!dryRun) {
        const pkg = await Bun.file(join(projectRoot, 'package.json')).json();
        console.log(`\nVersion ${pkg.version} published!`);
        console.log('\nUsers can now run:');
        console.log('  npx @twsxtd/hapi');
        console.log('  bunx @twsxtd/hapi');
    }
}

main().catch((error) => {
    console.error('\nPublish failed:', error.message);
    process.exit(1);
});
