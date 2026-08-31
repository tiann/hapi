import { createRequire } from 'node:module';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const binModulePath = path.resolve(process.cwd(), 'bin/hapi.cjs');
const {
    formatCommand,
    isSupportedPlatform,
    normalizeExecError,
    reportExecutionFailure,
    reportMissingPlatformPackage,
    reportUnsupportedPlatform,
} = require(binModulePath);

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

        expect(lines).toContain('Missing platform package: @youngfine/hapi-linux-x64');
        expect(lines).toContain('Try reinstalling with the official npm registry:');
        expect(lines).toContain('  npm install -g @youngfine/hapi --registry=https://registry.npmjs.org');
        expect(lines).toContain('Or download the binary manually from:');
        expect(lines).toContain('  https://github.com/Conanxy/hapi/releases');
    });
});
