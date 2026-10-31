import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const binModulePath = path.resolve(process.cwd(), 'bin/hapi.cjs');
const packageVersion = require(path.resolve(process.cwd(), 'package.json')).version;
const {
    formatCommand,
    isSupportedPlatform,
    normalizeExecError,
    reportExecutionFailure,
    reportMissingPlatformPackage,
    reportUnsupportedPlatform,
} = require(binModulePath);

describe('hapi binary launcher package versions', () => {
    const version = '1.2.3';
    const platformPackage = `@twsxtd/hapi-${process.platform}-${process.arch}`;
    let root: string;
    let mainDir: string;
    let launcherPath: string;

    function installPlatformPackage(installedVersion: string, parent = root): string {
        const packageDir = path.join(parent, 'node_modules', platformPackage);
        mkdirSync(packageDir, { recursive: true });
        writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
            name: platformPackage,
            version: installedVersion,
        }));
        return path.join(packageDir, 'bin', process.platform === 'win32' ? 'hapi.exe' : 'hapi');
    }

    beforeEach(() => {
        root = realpathSync(mkdtempSync(path.join(tmpdir(), 'hapi-launcher-')));
        mainDir = path.join(root, 'node_modules', '@twsxtd', 'hapi');
        launcherPath = path.join(mainDir, 'bin', 'hapi.cjs');
        mkdirSync(path.dirname(launcherPath), { recursive: true });
        copyFileSync(binModulePath, launcherPath);
        writeFileSync(path.join(mainDir, 'package.json'), JSON.stringify({
            name: '@twsxtd/hapi',
            version,
            optionalDependencies: { [platformPackage]: version },
        }));
    });

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    it('resolves a platform binary from the same release', () => {
        const binaryPath = installPlatformPackage(version);

        expect(require(launcherPath).getBinaryPath()).toBe(binaryPath);
    });

    it('validates the resolved dependency rather than a stale hoisted copy', () => {
        installPlatformPackage('1.2.2');
        const binaryPath = installPlatformPackage(version, mainDir);

        expect(require(launcherPath).getBinaryPath()).toBe(binaryPath);
    });

    it.each(['1.2.2', '2.0.0'])('rejects platform version %s before executing it', installedVersion => {
        installPlatformPackage(installedVersion);

        expect(() => require(launcherPath).getBinaryPath())
            .toThrow(`Expected ${version}, but found ${installedVersion}.`);

        const result = spawnSync(process.execPath, [launcherPath, '--version'], { encoding: 'utf-8' });

        expect(result.status).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain(`Platform package version mismatch: ${platformPackage}`);
        expect(result.stderr).toContain(`Expected ${version}, but found ${installedVersion}.`);
        expect(result.stderr).toContain(
            `bun remove -g @twsxtd/hapi && bun add -g @twsxtd/hapi@${version} --registry=https://registry.npmjs.org`
        );
        expect(result.stderr).not.toContain('Failed to execute:');
    });

    it('still diagnoses a missing optional dependency', () => {
        expect(require(launcherPath).getBinaryPath()).toBeNull();

        const result = spawnSync(process.execPath, [launcherPath, '--version'], { encoding: 'utf-8' });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`Missing platform package: ${platformPackage}`);
        expect(result.stderr).not.toContain('Platform package version mismatch:');
    });
});

describe('hapi binary launcher error reporting', () => {
    it('formats command with shell-safe JSON quoting', () => {
        const command = formatCommand('/tmp/hapi', ['serve', '--name', 'my agent']);
        expect(command).toBe('"/tmp/hapi" "serve" "--name" "my agent"');
    });

    it('normalizes child process execution errors', () => {
        const normalized = normalizeExecError({
            status: 132,
            signal: 'SIGILL',
            message: 'Command failed: /tmp/hapi',
        });

        expect(normalized).toEqual({
            status: 132,
            signal: 'SIGILL',
            message: 'Command failed: /tmp/hapi',
        });
    });

    it('reports execution details before exit handling', () => {
        const lines: string[] = [];
        const log = (line: string) => lines.push(line);

        const result = reportExecutionFailure(
            {
                status: 132,
                signal: 'SIGILL',
                message: 'Illegal instruction (core dumped)',
            },
            '/tmp/hapi',
            ['serve', '--port', '3000'],
            log,
        );

        expect(result).toEqual({ status: 132, signal: 'SIGILL' });
        expect(lines).toEqual([
            'Failed to execute: "/tmp/hapi" "serve" "--port" "3000"',
            'Binary terminated by signal SIGILL.',
            'Binary exited with status 132.',
            'Illegal instruction (core dumped)',
        ]);
    });

    it('handles unknown failures with generic output', () => {
        const lines: string[] = [];

        const result = reportExecutionFailure({}, '/tmp/hapi', [], (line: string) => {
            lines.push(line);
        });

        expect(result).toEqual({ status: null, signal: null });
        expect(lines).toEqual(['Failed to execute: "/tmp/hapi"']);
    });

    it('distinguishes supported and unsupported platforms', () => {
        expect(isSupportedPlatform('linux', 'x64')).toBe(true);
        expect(isSupportedPlatform('linux', 'ppc64')).toBe(false);
    });

    it('reports unsupported platform with supported list', () => {
        const lines: string[] = [];
        reportUnsupportedPlatform('linux', 'ppc64', (line: string) => {
            lines.push(line);
        });

        expect(lines).toContain('Unsupported platform: linux-ppc64');
        expect(lines).toContain('Supported platforms:');
        expect(lines).toContain('  - linux-x64');
    });

    it('reports missing platform package with installation guidance', () => {
        const lines: string[] = [];
        reportMissingPlatformPackage('linux', 'x64', (line: string) => {
            lines.push(line);
        });

        expect(lines).toContain('Missing platform package: @twsxtd/hapi-linux-x64');
        expect(lines).toContain('Try reinstalling with the official npm registry:');
        expect(lines).toContain(`  npm install -g @twsxtd/hapi@${packageVersion} --registry=https://registry.npmjs.org`);
        expect(lines).toContain(
            `  bun remove -g @twsxtd/hapi && bun add -g @twsxtd/hapi@${packageVersion} --registry=https://registry.npmjs.org`
        );
        expect(lines).toContain('Or download the binary manually from:');
        expect(lines).toContain('  https://github.com/tiann/hapi/releases');
    });
});
