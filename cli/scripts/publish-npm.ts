#!/usr/bin/env bun
/**
 * Publish the CLI to npm. Runs in the Release workflow via npm Trusted Publishing (OIDC),
 * so no npm token is needed. Expects binaries in dist-exe (`bun run build:single-exe:all`).
 *
 * 1. Prepare npm packages from dist-exe
 * 2. Publish platform packages
 * 3. Wait until every platform package is live on npm
 * 4. Publish the main package
 *
 * Packages already on npm are skipped, so a failed run can simply be re-run.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const projectRoot = join(import.meta.dir, '..');
const dryRun = process.argv.includes('--dry-run');

const platforms = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'];
const mainPackage = '@twsxtd/hapi';

function run(cmd: string, cwd = projectRoot): void {
    console.log(`\n$ ${cmd}`);
    execSync(cmd, { cwd, stdio: 'inherit' });
}

function isPublished(name: string, version: string): boolean {
    try {
        const published = execSync(`npm view ${name}@${version} version`, {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        return published === version;
    } catch {
        return false;
    }
}

function publish(name: string, version: string, dir: string): void {
    if (isPublished(name, version)) {
        console.log(`   ✓ ${name}@${version} already published, skipping`);
        return;
    }
    run(`npm publish --access public${dryRun ? ' --dry-run' : ''}`, dir);
}

async function waitForPackages(names: string[], version: string): Promise<void> {
    const timeoutMs = 10 * 60 * 1000;
    const intervalMs = 15_000;
    const deadline = Date.now() + timeoutMs;
    const pending = new Set(names);

    while (pending.size > 0) {
        for (const name of [...pending]) {
            if (isPublished(name, version)) {
                console.log(`   ✓ ${name}@${version} is live on npm`);
                pending.delete(name);
            }
        }
        if (pending.size === 0) {
            return;
        }
        if (Date.now() >= deadline) {
            console.error(`❌ Timed out waiting for platform packages on npm: ${[...pending].join(', ')}`);
            console.error('   The main package was NOT published. Re-run the workflow to retry.');
            process.exit(1);
        }
        console.log(`   ⏳ Waiting for: ${[...pending].join(', ')} (retry in ${intervalMs / 1000}s)...`);
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
}

async function main(): Promise<void> {
    const version: string = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8')).version;
    console.log(`\n📤 Publishing ${mainPackage}@${version} to npm${dryRun ? ' (dry-run)' : ''}`);

    run('bun run prepare-npm-packages');

    const platformPackages = platforms.map(platform => `${mainPackage}-${platform}`);
    for (const [index, platform] of platforms.entries()) {
        publish(platformPackages[index], version, join(projectRoot, 'npm', platform));
    }

    // The main package pins platform packages via optionalDependencies, so publishing it first
    // would let users install a version whose platform binary does not exist yet.
    if (!dryRun) {
        console.log('\n🔍 Verifying platform packages are live on npm...');
        await waitForPackages(platformPackages, version);
    }

    publish(mainPackage, version, join(projectRoot, 'npm', 'main'));
    console.log(`\n✅ Published ${mainPackage}@${version} to npm`);
}

main().catch(err => {
    console.error('Publish failed:', err);
    process.exit(1);
});
