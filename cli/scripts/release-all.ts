#!/usr/bin/env bun
/**
 * Start a release:
 * 1. Bump CLI, shared, iOS, and Android versions
 * 2. Refresh bun.lock for the new workspace version
 * 3. Git commit + tag + push
 *
 * Pushing the tag triggers .github/workflows/release.yml, which builds the binaries,
 * publishes to npm via Trusted Publishing, and creates the GitHub Release.
 */

import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { updateReleaseVersions } from './release-version';

const repoRoot = join(import.meta.dir, '..', '..');

const args = process.argv.slice(2);
const version = args.find(arg => !arg.startsWith('--'));
const dryRun = args.includes('--dry-run');

if (!version) {
    console.error('Usage: bun run scripts/release-all.ts <version> [--dry-run]');
    console.error('Example: bun run scripts/release-all.ts 0.2.0');
    process.exit(1);
}

const releaseFiles = [
    'cli/package.json',
    'shared/src/buildInfo.ts',
    'ios/Hapi.xcodeproj/project.pbxproj',
    'android/app/build.gradle.kts',
    'bun.lock',
];

function git(cmd: string): string {
    return execSync(`git ${cmd}`, { encoding: 'utf-8', cwd: repoRoot }).trim();
}

function run(cmd: string): void {
    console.log(`\n$ ${cmd}`);
    if (!dryRun) {
        execSync(cmd, { cwd: repoRoot, stdio: 'inherit' });
    }
}

function fail(message: string): never {
    console.error(`❌ ${message}`);
    process.exit(1);
}

function main(version: string): void {
    const tag = `v${version}`;
    console.log(`\n🚀 Starting release ${tag}${dryRun ? ' (dry-run)' : ''}\n`);

    console.log('🔍 Pre-checks...');
    const currentBranch = git('branch --show-current');
    if (currentBranch !== 'main') {
        fail(`Release must be run from main branch (current: ${currentBranch})`);
    }
    console.log('   ✓ On main branch');

    if (git('status --porcelain') !== '') {
        fail('Working tree is not clean. Commit or stash your changes first.');
    }
    console.log('   ✓ Working tree is clean');

    if (git(`tag --list ${tag}`) !== '') {
        fail(`Tag ${tag} already exists`);
    }
    console.log(`   ✓ Tag ${tag} is available`);

    console.log('\n📦 Step 1: Updating CLI, shared, iOS, and Android versions...');
    const oldVersion = updateReleaseVersions(repoRoot, version, dryRun);
    console.log(`   ${oldVersion} → ${version}`);

    console.log('\n📥 Step 2: Updating lockfile...');
    run('bun install --lockfile-only');

    console.log('\n📝 Step 3: Creating git commit and tag...');
    run(`git add ${releaseFiles.join(' ')}`);
    run(`git commit -m "Release version ${version}"`);
    run(`git tag ${tag}`);
    run(`git push --atomic origin main ${tag}`);

    console.log(`\n✅ Pushed ${tag}. The Release workflow will build and publish it:`);
    console.log('   https://github.com/tiann/hapi/actions/workflows/release.yml');
}

main(version);
