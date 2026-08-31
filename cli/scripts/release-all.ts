#!/usr/bin/env bun
/**
 * Unified release script that handles the complete release flow:
 * 1. Bump version
 * 2. Build binaries (with embedded web assets)
 * 3. Publish platform packages first (the wrapper pins them exactly)
 * 4. Verify all platform packages are live on npm
 * 5. Publish main package
 * 6. Git commit + tag + push
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const scriptDir = import.meta.dir;
const projectRoot = join(scriptDir, '..');
const repoRoot = join(projectRoot, '..');
const buildInfoPath = join(repoRoot, 'shared', 'src', 'buildInfo.ts');
const NPM_SCOPE = '@youngfine';
const MAIN_PACKAGE = `${NPM_SCOPE}/hapi`;
const NPM_DIST_TAG = 'latest';
const VERSION_PATTERN = /^\d+\.\d+\.\d+-youngfine\.\d+$/;

// 解析参数
const args = process.argv.slice(2);
const version = args.find(arg => !arg.startsWith('--'));
const dryRun = args.includes('--dry-run');
const publishNpm = args.includes('--publish-npm');  // 只发布 npm，跳过 git 操作
const skipBuild = args.includes('--skip-build');    // 跳过构建（二进制已存在）

if (!version) {
    console.error('Usage: bun run scripts/release-all.ts <version> [options]');
    console.error('Options:');
    console.error('  --dry-run      Validate package preparation and npm publishing without uploading');
    console.error('  --publish-npm  Only publish to npm, skip git operations');
    console.error('  --skip-build   Skip building binaries (use existing)');
    console.error('Example: bun run scripts/release-all.ts 0.29.0-youngfine.1');
    process.exit(1);
}
if (!VERSION_PATTERN.test(version)) {
    console.error(`Version must match <upstream>-youngfine.<revision>, for example 0.29.0-youngfine.1`);
    process.exit(1);
}

function run(
    cmd: string,
    cwd = projectRoot,
    options: { executeDuringDryRun?: boolean } = {}
): void {
    console.log(`\n$ ${cmd}`);
    if (!dryRun || options.executeDuringDryRun) {
        execSync(cmd, { cwd, stdio: 'inherit' });
    }
}

function packageVersionExists(name: string, expectedVersion: string): boolean {
    try {
        const published = execSync(
            `npm view ${name}@${expectedVersion} version`,
            { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
        ).trim();
        return published === expectedVersion;
    } catch {
        return false;
    }
}

function publishPackage(name: string, cwd: string, provenanceFlag: string): void {
    if (!dryRun && packageVersionExists(name, version!)) {
        console.log(`   ✓ ${name}@${version} already published; skipping`);
        return;
    }
    run(
        `npm publish --access public --tag ${NPM_DIST_TAG}${provenanceFlag}${dryRun ? ' --dry-run' : ''}`,
        cwd,
        { executeDuringDryRun: dryRun }
    );
}

function updateBuildInfoVersion(nextVersion: string): void {
    const content = readFileSync(buildInfoPath, 'utf-8');
    if (!/export const APP_VERSION = ['"][^'"]+['"]/.test(content)) {
        throw new Error(`Could not find APP_VERSION in ${buildInfoPath}`);
    }
    const updated = content.replace(
        /export const APP_VERSION = ['"][^'"]+['"]/,
        `export const APP_VERSION = '${nextVersion}'`
    );

    if (!dryRun && updated !== content) {
        writeFileSync(buildInfoPath, updated);
    }
}

async function waitForPlatformPackages(platforms: string[], expectedVersion: string): Promise<void> {
    const timeoutMs = 10 * 60 * 1000;
    const intervalMs = 15_000;
    const deadline = Date.now() + timeoutMs;
    const pending = new Set(platforms.map(platform => `${NPM_SCOPE}/hapi-${platform}`));

    while (pending.size > 0) {
        for (const name of [...pending]) {
            try {
                const published = execSync(`npm view ${name}@${expectedVersion} version`, { encoding: 'utf-8' }).trim();
                if (published === expectedVersion) {
                    console.log(`   ✓ ${name}@${expectedVersion} is live on npm`);
                    pending.delete(name);
                }
            } catch {
                // Not published yet, keep waiting
            }
        }
        if (pending.size === 0) {
            return;
        }
        if (Date.now() >= deadline) {
            console.error(`❌ Timed out waiting for platform packages on npm: ${[...pending].join(', ')}`);
            console.error('   The main package was NOT published. Publish the missing platform packages and re-run with --publish-npm.');
            process.exit(1);
        }
        console.log(`   ⏳ Waiting for: ${[...pending].join(', ')} (retry in ${intervalMs / 1000}s)...`);
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
}

async function main(): Promise<void> {
    const flags = [dryRun && 'dry-run', publishNpm && 'publish-npm', skipBuild && 'skip-build'].filter(Boolean);
    console.log(`\n🚀 Starting release v${version}${flags.length ? ` (${flags.join(', ')})` : ''}\n`);

    // Pre-check: Ensure we're on main branch
    console.log('🔍 Pre-checks...');
    const currentBranch = execSync('git branch --show-current', { encoding: 'utf-8', cwd: repoRoot }).trim();
    const githubMain = process.env.GITHUB_ACTIONS === 'true'
        && process.env.GITHUB_REF_NAME === 'main';
    if (currentBranch !== 'main' && !dryRun && !githubMain) {
        console.error(`❌ Release must be run from main branch (current: ${currentBranch})`);
        process.exit(1);
    }
    console.log(currentBranch === 'main' || githubMain
        ? '   ✓ On main branch'
        : `   ✓ Dry-run allowed from ${currentBranch}`);

    // Pre-check: Ensure npm is logged in (skip in dry-run mode)
    if (!dryRun && process.env.GITHUB_ACTIONS !== 'true') {
        try {
            const npmUser = execSync('npm whoami', { encoding: 'utf-8' }).trim();
            if (npmUser !== 'youngfine') {
                throw new Error(`Expected npm user youngfine, got ${npmUser}`);
            }
            console.log(`   ✓ Logged in to npm as: ${npmUser}`);
        } catch {
            console.error(`❌ Not logged in to npm as youngfine. Run \`npm login\` first.`);
            process.exit(1);
        }
    } else if (process.env.GITHUB_ACTIONS === 'true') {
        console.log('   ✓ GitHub Actions trusted publishing mode');
    } else {
        console.log('   ✓ Skipping npm login check (dry-run)');
    }

    // Step 1: Update package.json version
    console.log('📦 Step 1: Updating package.json version...');
    const pkgPath = join(projectRoot, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    if (pkg.name !== MAIN_PACKAGE) {
        throw new Error(`Expected package name ${MAIN_PACKAGE}, got ${pkg.name}`);
    }
    if ((publishNpm || dryRun) && pkg.version !== version) {
        throw new Error(
            `${publishNpm ? '--publish-npm' : '--dry-run'} requires ${projectRoot}/package.json to already contain version ${version}`
        );
    }
    const oldVersion = pkg.version;
    pkg.version = version;
    if (!dryRun) {
        writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    }
    updateBuildInfoVersion(version);
    console.log(`   ${oldVersion} → ${version}`);

    // Step 2: Build all platform binaries (with embedded web assets)
    if (!skipBuild) {
        console.log('\n🔨 Step 2: Building all platform binaries with web assets...');
        run('bun run build:single-exe:all', repoRoot, { executeDuringDryRun: dryRun });
    } else {
        console.log('\n🔨 Step 2: Skipping build (--skip-build)');
    }

    // Step 3: Prepare and publish platform packages
    console.log('\n📤 Step 3: Publishing platform packages...');
    run('bun run prepare-npm-packages', projectRoot, { executeDuringDryRun: dryRun });
    const platforms = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'];
    const provenanceFlag = process.env.GITHUB_ACTIONS === 'true' ? ' --provenance' : '';
    for (const platform of platforms) {
        const npmDir = join(projectRoot, 'npm', platform);
        publishPackage(`${NPM_SCOPE}/hapi-${platform}`, npmDir, provenanceFlag);
    }

    // Step 4: Verify all platform packages are live on npm before publishing the main package.
    // The main package pins platform packages via optionalDependencies, so publishing it first
    // would let users install a version whose platform binary does not exist yet.
    if (dryRun) {
        console.log('\n🔍 Step 4: Skipping platform package verification (dry-run)');
    } else {
        console.log('\n🔍 Step 4: Verifying platform packages are live on npm...');
        await waitForPlatformPackages(platforms, version);
    }

    // Step 5: Publish main package
    console.log('\n📤 Step 5: Publishing main package...');
    const mainNpmDir = join(projectRoot, 'npm', 'main');
    publishPackage(MAIN_PACKAGE, mainNpmDir, provenanceFlag);

    if (dryRun) {
        console.log(`\n✅ Dry-run validation completed for v${version}. No packages or git refs were published.`);
        return;
    }

    // --publish-npm 模式到此结束
    if (publishNpm) {
        console.log(`\n✅ Published v${version} to npm!`);
        return;
    }

    // Step 6: Git commit + tag + push
    console.log('\n📝 Step 6: Creating git commit and tag...');
    run(`git add .`, repoRoot);
    run(`git commit -m "Release version ${version}"`, repoRoot);
    run(`git tag v${version}`, repoRoot);
    run(`git push && git push --tags`, repoRoot);

    console.log(`\n✅ Release v${version} completed!`);
}

main().catch(err => {
    console.error('Release failed:', err);
    process.exit(1);
});
