#!/usr/bin/env bun
/**
 * Unified release script that handles the complete release flow:
 * 1. Bump version
 * 2. Build binaries (with embedded web assets)
 * 3. Publish platform packages first (so lockfile can resolve them)
 * 4. Publish main package
 * 5. bun install --lockfile-only --os=* --cpu=* (to lock all platform packages)
 * 6. Git commit + tag + push
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const scriptDir = import.meta.dir;
const projectRoot = join(scriptDir, '..');
const repoRoot = join(projectRoot, '..');
const buildInfoPath = join(repoRoot, 'shared', 'src', 'buildInfo.ts');

const platforms = [
    { npm: 'darwin-arm64', target: 'bun-darwin-arm64', bin: 'hapi', helper: 'hapi-local' },
    { npm: 'darwin-x64', target: 'bun-darwin-x64', bin: 'hapi', helper: 'hapi-local' },
    { npm: 'linux-arm64', target: 'bun-linux-arm64', bin: 'hapi', helper: 'hapi-local' },
    { npm: 'linux-x64', target: 'bun-linux-x64-baseline', bin: 'hapi', helper: 'hapi-local' },
    { npm: 'win32-x64', target: 'bun-windows-x64', bin: 'hapi.exe', helper: 'hapi-local.exe' }
] as const;

// 解析参数
const args = process.argv.slice(2);
const version = args.find(arg => !arg.startsWith('--'));
const dryRun = args.includes('--dry-run');
const publishNpm = args.includes('--publish-npm');  // 只发布 npm，跳过 git 操作
const skipBuild = args.includes('--skip-build');    // 跳过构建（二进制已存在）

if (!version) {
    console.error('Usage: bun run scripts/release-all.ts <version> [options]');
    console.error('Options:');
    console.error('  --dry-run      Preview the release process');
    console.error('  --publish-npm  Only publish to npm, skip git operations');
    console.error('  --skip-build   Use existing CI/matrix dist-exe binaries');
    console.error('Example: bun run scripts/release-all.ts 0.2.0');
    process.exit(1);
}

function run(cmd: string, cwd = projectRoot): void {
    console.log(`\n$ ${cmd}`);
    if (!dryRun) {
        execSync(cmd, { cwd, stdio: 'inherit' });
    }
}

function updateBuildInfoVersion(nextVersion: string): void {
    const content = readFileSync(buildInfoPath, 'utf-8');
    const updated = content.replace(
        /export const APP_VERSION = ['"][^'"]+['"]/,
        `export const APP_VERSION = '${nextVersion}'`
    );

    if (updated === content) {
        throw new Error(`Could not update APP_VERSION in ${buildInfoPath}`);
    }

    if (!dryRun) {
        writeFileSync(buildInfoPath, updated);
    }
}

function verifyReleaseBinaries(): void {
    const missing: string[] = [];
    for (const platform of platforms) {
        for (const file of [platform.bin, platform.helper]) {
            const path = join(projectRoot, 'dist-exe', platform.target, file);
            if (!existsSync(path)) {
                missing.push(`${platform.npm}: ${path}`);
            }
        }
    }

    if (missing.length > 0) {
        throw new Error([
            'Missing release binaries/native helpers.',
            'Download the GitHub release matrix artifacts into cli/dist-exe and rerun with --skip-build.',
            ...missing.map(path => `  - ${path}`)
        ].join('\n'));
    }
    console.log('   ✓ dist-exe contains hapi + hapi-local for all platforms');
}

async function runWithTimeoutRetry(cmd: string, cwd = projectRoot): Promise<void> {
    const timeoutCmd = `timeout 60s ${cmd}`;
    while (true) {
        console.log(`\n$ ${timeoutCmd}`);
        if (dryRun) {
            return;
        }
        try {
            execSync(timeoutCmd, { cwd, stdio: 'inherit' });
            return;
        } catch {
            console.warn(`⚠️ ${cmd} failed or timed out. Retrying in 60s...`);
            await new Promise(resolve => setTimeout(resolve, 60_000));
        }
    }
}

async function main(): Promise<void> {
    const flags = [dryRun && 'dry-run', publishNpm && 'publish-npm', skipBuild && 'skip-build'].filter(Boolean);
    console.log(`\n🚀 Starting release v${version}${flags.length ? ` (${flags.join(', ')})` : ''}\n`);

    // Pre-check: Ensure we're on main branch
    console.log('🔍 Pre-checks...');
    const currentBranch = execSync('git branch --show-current', { encoding: 'utf-8', cwd: repoRoot }).trim();
    if (currentBranch !== 'main') {
        console.error(`❌ Release must be run from main branch (current: ${currentBranch})`);
        process.exit(1);
    }
    console.log('   ✓ On main branch');

    // Pre-check: Ensure npm is logged in (skip in dry-run mode)
    if (!dryRun) {
        try {
            const npmUser = execSync('npm whoami', { encoding: 'utf-8' }).trim();
            console.log(`   ✓ Logged in to npm as: ${npmUser}`);
        } catch {
            console.error('❌ Not logged in to npm. Run `npm login` first.');
            process.exit(1);
        }
    } else {
        console.log('   ✓ Skipping npm login check (dry-run)');
    }

    // Step 1: Update package.json version
    console.log('📦 Step 1: Updating package.json version...');
    const pkgPath = join(projectRoot, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const oldVersion = pkg.version;
    pkg.version = version;
    if (!dryRun) {
        writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    }
    updateBuildInfoVersion(version);
    console.log(`   ${oldVersion} → ${version}`);

    // Step 2: Build all platform binaries (with embedded web assets)
    if (!skipBuild) {
        if (!process.env.HAPI_NATIVE_HELPER_PREBUILT_DIR && !dryRun) {
            console.error([
                '\n❌ Local all-platform release build is disabled.',
                'Native hapi-local must be built on matching CI runners.',
                'Use the GitHub release matrix, download artifacts into cli/dist-exe, then rerun with --skip-build.'
            ].join('\n'));
            process.exit(1);
        }
        console.log('\n🔨 Step 2: Building all platform binaries with prebuilt native helpers...');
        run('bun run build:single-exe:all', repoRoot);
    } else {
        console.log('\n🔨 Step 2: Using existing dist-exe artifacts (--skip-build)');
    }
    if (!dryRun) {
        verifyReleaseBinaries();
    }

    // Step 3: Prepare and publish platform packages
    console.log('\n📤 Step 3: Publishing platform packages...');
    run('bun run prepare-npm-packages');
    for (const platform of platforms) {
        const npmDir = join(projectRoot, 'npm', platform.npm);
        run(`npm publish --access public${dryRun ? ' --dry-run' : ''}`, npmDir);
    }

    // Step 4: Publish main package
    console.log('\n📤 Step 4: Publishing main package...');
    const mainNpmDir = join(projectRoot, 'npm', 'main');
    run(`npm publish --access public${dryRun ? ' --dry-run' : ''}`, mainNpmDir);

    // --publish-npm 模式到此结束
    if (publishNpm) {
        console.log(`\n✅ Published v${version} to npm!`);
        return;
    }

    // Step 5: bun install to get complete lockfile
    console.log('\n📥 Step 5: Updating lockfile for all platform packages...');

    await runWithTimeoutRetry('bun install --lockfile-only --os=* --cpu=*', repoRoot);
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
