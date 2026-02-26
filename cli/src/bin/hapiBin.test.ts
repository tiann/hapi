import { createRequire } from 'node:module';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const binModulePath = path.resolve(process.cwd(), 'bin/hapi.cjs');
const { formatCommand, normalizeExecError, reportExecutionFailure } = require(binModulePath);

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
});
