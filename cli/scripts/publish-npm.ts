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
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import spawn from 'cross-spawn';

const platforms = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'];
const mainPackage = '@twsxtd/hapi';
const registry = 'https://registry.npmjs.org/';
const defaultWaitMs = 30 * 60 * 1000;
const pollIntervalMs = 15_000;
const lookupTimeoutMs = 12_000;
const retryableCodes = new Set([
    'E408', 'E429', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND',
    'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ESOCKETTIMEDOUT',
    'ECONNECTIONTIMEOUT', 'EIDLETIMEOUT', 'ERESPONSETIMEOUT', 'ETRANSFERTIMEOUT',
]);

type LookupResult = { state: 'visible' } | { state: 'missing' | 'retryable'; code: string };

function run(cmd: string, cwd: string): void {
    console.log(`\n$ ${cmd}`);
    execSync(cmd, { cwd, stdio: 'inherit' });
}

function npmErrorCode(output: string | null): string | undefined {
    if (!output) return undefined;
    try {
        const code: unknown = JSON.parse(output)?.error?.code;
        // Do not log arbitrary npm output, which can include registry credentials.
        return typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : undefined;
    } catch {
        return undefined;
    }
}

function lookupVersion(name: string, version: string, timeoutMs = lookupTimeoutMs): LookupResult {
    const spec = `${name}@${version}`;
    const result = spawn.sync('npm', [
        'view', spec, 'version', '--json', '--prefer-online',
        `--registry=${registry}`, `--@twsxtd:registry=${registry}`,
        '--fetch-retries=0', `--fetch-timeout=${Math.min(timeoutMs, 10_000)}`,
    ], {
        encoding: 'utf-8',
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
    });

    if (result.status === 0 && !result.error) {
        if (result.stdout?.trim() === JSON.stringify(version)) return { state: 'visible' };
        throw new Error(`npm view returned an unexpected version response for ${spec}`);
    }

    const code = (result.error as NodeJS.ErrnoException | undefined)?.code
        ?? npmErrorCode(result.stdout)
        ?? result.stderr?.match(/^npm (?:error|ERR!) code ([A-Z][A-Z0-9_]*)$/m)?.[1]
        ?? (result.signal ?? `exit ${result.status}`);
    if (code === 'E404' || code === 'ETARGET') return { state: 'missing', code };
    if (retryableCodes.has(code) || /^E5\d\d$/.test(code)) return { state: 'retryable', code };
    throw new Error(`npm view failed for ${spec} (${code})`);
}

async function publish(name: string, version: string, dir: string, dryRun: boolean): Promise<void> {
    // On a rerun, a network error is not evidence that it's safe to publish again.
    for (let attempt = 1; ; attempt++) {
        const result = lookupVersion(name, version);
        if (result.state === 'visible') {
            console.log(`   ✓ ${name}@${version} already published, skipping`);
            return;
        }
        if (result.state === 'missing') {
            run(`npm publish --access public${dryRun ? ' --dry-run' : ''}`, dir);
            return;
        }
        if (attempt === 3) {
            throw new Error(`Could not check ${name}@${version} before publishing after ${attempt} attempts (${result.code}). Re-run the workflow to retry.`);
        }
        console.warn(`   npm registry lookup for ${name}@${version} failed (${result.code}); retrying in 3s`);
        await sleep(3_000);
    }
}

async function waitForPackages(names: string[], version: string, timeoutMs: number): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    const pending = new Map<string, string>(names.map(name => [name, 'not checked']));

    while (pending.size > 0) {
        for (const name of pending.keys()) {
            const remainingMs = Math.floor(deadline - performance.now());
            if (remainingMs < 1) break;
            const result = lookupVersion(name, version, Math.min(remainingMs, lookupTimeoutMs));
            if (result.state === 'visible') {
                console.log(`   ✓ ${name}@${version} is live on npm`);
                pending.delete(name);
            } else {
                pending.set(name, result.state === 'missing' ? `not visible yet: ${result.code}` : `registry lookup failed: ${result.code}`);
            }
        }
        if (pending.size === 0) return;

        const details = Array.from(pending, ([name, status]) => `${name}@${version} (${status})`).join(', ');
        const delayMs = Math.min(pollIntervalMs, Math.floor(deadline - performance.now()));
        if (delayMs < 1) {
            throw new Error(`Timed out waiting for platform packages on npm: ${details}. The main package was NOT published. Once the versions are visible, re-run the workflow to retry.`);
        }
        console.log(`   ⏳ Waiting for: ${details} (retry in ${Math.ceil(delayMs / 1000)}s)...`);
        await sleep(delayMs);
    }
}

function getWaitTimeoutMs(value: string | undefined): number {
    if (!value) return defaultWaitMs;
    const ms = Number(value) * 1000;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(ms) || ms < 1000) {
        throw new Error('NPM_PUBLISH_WAIT_TIMEOUT_SECONDS must be a positive integer');
    }
    return ms;
}

export async function publishNpm(
    projectRoot: string,
    dryRun: boolean,
    waitTimeoutSeconds = process.env.NPM_PUBLISH_WAIT_TIMEOUT_SECONDS,
): Promise<void> {
    const waitTimeoutMs = getWaitTimeoutMs(waitTimeoutSeconds);
    const version: string = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8')).version;
    console.log(`\n📤 Publishing ${mainPackage}@${version} to npm${dryRun ? ' (dry-run)' : ''}`);

    run('bun run prepare-npm-packages', projectRoot);

    const platformPackages = platforms.map(platform => `${mainPackage}-${platform}`);
    for (const [index, platform] of platforms.entries()) {
        await publish(platformPackages[index], version, join(projectRoot, 'npm', platform), dryRun);
    }

    // The main package pins platform packages via optionalDependencies, so publishing it first
    // would let users install a version whose platform binary does not exist yet.
    if (!dryRun) {
        console.log(`\n🔍 Verifying platform packages are live on npm (timeout: ${waitTimeoutMs / 1000}s)...`);
        await waitForPackages(platformPackages, version, waitTimeoutMs);
    }

    await publish(mainPackage, version, join(projectRoot, 'npm', 'main'), dryRun);
    console.log(`\n✅ Published ${mainPackage}@${version} to npm`);
}

if (import.meta.main) {
    publishNpm(fileURLToPath(new URL('..', import.meta.url)), process.argv.includes('--dry-run')).catch((err: unknown) => {
        console.error('Publish failed:', err);
        process.exitCode = 1;
    });
}
