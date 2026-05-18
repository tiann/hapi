import { afterEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';

const mocks = vi.hoisted(() => ({
    createReadStream: vi.fn(() => new PassThrough())
}));

vi.mock('node:fs', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:fs')>()),
    createReadStream: mocks.createReadStream
}));

import { createHapiMcpStdin } from './happyMcpStdioBridge';

describe('createHapiMcpStdin', () => {
    const originalBunVersion = process.versions.bun;

    afterEach(() => {
        if (originalBunVersion === undefined) {
            Reflect.deleteProperty(process.versions, 'bun');
        } else {
            Object.defineProperty(process.versions, 'bun', {
                value: originalBunVersion,
                configurable: true
            });
        }
        vi.clearAllMocks();
    });

    it('uses an explicit fd 0 fs stream under Bun to avoid process.stdin EPERM', () => {
        Object.defineProperty(process.versions, 'bun', {
            value: '1.3.13',
            configurable: true
        });

        const stdin = createHapiMcpStdin();

        expect(mocks.createReadStream).toHaveBeenCalledWith('/dev/stdin', { fd: 0, autoClose: false });
        expect(stdin).not.toBe(process.stdin);
    });

    it('keeps process.stdin outside Bun', () => {
        Reflect.deleteProperty(process.versions, 'bun');

        const stdin = createHapiMcpStdin();

        expect(stdin).toBe(process.stdin);
        expect(mocks.createReadStream).not.toHaveBeenCalled();
    });
});
