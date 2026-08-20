import { spawn as spawnChild, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fsOverrides, spawnSyncMock } = vi.hoisted(() => ({
    fsOverrides: {
        readdirSync: null as ((...args: unknown[]) => unknown) | null,
        readFileSync: null as ((...args: unknown[]) => unknown) | null,
        statSync: null as ((...args: unknown[]) => unknown) | null
    },
    spawnSyncMock: vi.fn()
}));

vi.mock('node:fs', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    return {
        ...actual,
        readdirSync: (...args: Parameters<typeof actual.readdirSync>) => (
            fsOverrides.readdirSync
                ? fsOverrides.readdirSync(...args)
                : actual.readdirSync(...args)
        ),
        readFileSync: (...args: Parameters<typeof actual.readFileSync>) => (
            fsOverrides.readFileSync
                ? fsOverrides.readFileSync(...args)
                : actual.readFileSync(...args)
        ),
        statSync: (...args: Parameters<typeof actual.statSync>) => (
            fsOverrides.statSync
                ? fsOverrides.statSync(...args)
                : actual.statSync(...args)
        )
    };
});

vi.mock('cross-spawn', () => ({
    default: Object.assign(vi.fn(), { sync: spawnSyncMock })
}));

import {
    getProcessStartMarker,
    isProcessAlive,
    killProcess,
    killProcessByChildProcess
} from './process';

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
const rootMarker = '2026-08-20T08:00:00.1234560Z';
const childMarker = '2026-08-20T08:00:01.1234560Z';
const strictOwnershipEnv = 'HAPI_STRICT_PROCESS_OWNERSHIP_TOKEN';

function powershellScript(args: unknown): string {
    return Array.isArray(args) ? String(args.at(-1) ?? '') : '';
}

function processTable(rows: Array<{ pid: number; parentPid: number; marker: string }>): Buffer {
    return Buffer.from(rows.map((row) => (
        `${row.pid}|${row.parentPid}|${row.marker}`
    )).join('\n'));
}

function rootProcessTableResult(args: unknown): { status: number; stdout: Buffer } | null {
    if (!powershellScript(args).includes('ParentProcessId')) return null;
    return {
        status: 0,
        stdout: processTable([{ pid: 123, parentPid: 1, marker: rootMarker }])
    };
}

function wmicProcessTable(rows: Array<{
    pid: number;
    parentPid: number;
    creationDate: string;
}>): Buffer {
    return Buffer.from(rows.map((row) => [
        `CreationDate=${row.creationDate}`,
        `ParentProcessId=${row.parentPid}`,
        `ProcessId=${row.pid}`
    ].join('\r\n')).join('\r\n\r\n'));
}

function processExited(): never {
    throw Object.assign(new Error('process exited'), { code: 'ESRCH' });
}

function requireProcessStartMarker(pid: number): string {
    const marker = getProcessStartMarker(pid);
    if (marker === null) throw new Error(`Could not capture process marker for PID ${pid}`);
    return marker;
}

function taskkillCalls(): unknown[][] {
    return spawnSyncMock.mock.calls.filter(([command]) => command === 'taskkill');
}

describe('killProcess on Windows', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        Object.defineProperty(process, 'platform', {
            ...platformDescriptor,
            value: 'win32'
        });
        spawnSyncMock.mockReset();
        spawnSyncMock.mockImplementation((command: string, args: unknown) => {
            if (command === 'powershell') {
                if (powershellScript(args).includes('ParentProcessId')) {
                    return {
                        status: 0,
                        stdout: processTable([{ pid: 123, parentPid: 1, marker: rootMarker }])
                    };
                }
                return { status: 0, stdout: Buffer.from(`${rootMarker}\n`) };
            }
            return { status: 0 };
        });
    });

    afterEach(() => {
        Object.defineProperty(process, 'platform', platformDescriptor);
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('keeps the legacy taskkill tree path when no marker is supplied', async () => {
        vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);

        await expect(killProcess(123)).resolves.toBe(true);

        expect(taskkillCalls()).toHaveLength(1);
        expect(taskkillCalls()[0]?.[1]).toEqual(expect.arrayContaining(['/T', '/PID', '123']));
        expect(taskkillCalls()[0]?.[2]).not.toHaveProperty('timeout');
        expect(spawnSyncMock.mock.calls.some(([command]) => command === 'powershell')).toBe(false);
    });

    it('bounds legacy taskkill when the caller supplies a deadline', async () => {
        vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);

        await expect(
            killProcess(123, false, undefined, Date.now() + 100)
        ).resolves.toBe(true);

        expect(taskkillCalls()).toHaveLength(1);
        expect(taskkillCalls()[0]?.[2]).toHaveProperty('timeout');
        expect((taskkillCalls()[0]?.[2] as { timeout: number }).timeout).toBeLessThanOrEqual(100);
    });

    it('fails closed without taskkill when marker capture failed', async () => {
        vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);

        await expect(killProcess(123, false, null)).resolves.toBe(false);

        expect(spawnSyncMock).not.toHaveBeenCalled();
    });

    it('rejects a PID generation captured after spawn', async () => {
        vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);
        spawnSyncMock.mockImplementation((command: string, args: unknown) => {
            if (command === 'powershell') {
                if (powershellScript(args).includes('ParentProcessId')) {
                    return {
                        status: 0,
                        stdout: processTable([{ pid: 123, parentPid: 1, marker: childMarker }])
                    };
                }
                return { status: 0, stdout: Buffer.from(`${childMarker}\n`) };
            }
            return { status: 0 };
        });

        const result = killProcess(123, false, rootMarker);
        await vi.advanceTimersByTimeAsync(3_000);

        await expect(result).resolves.toBe(false);

        expect(taskkillCalls()).toHaveLength(0);
    });

    it('waits for the expected process generation to exit', async () => {
        let alive = true;
        vi.spyOn(process, 'kill').mockImplementation((() => {
            if (alive) return true;
            return processExited();
        }) as typeof process.kill);
        spawnSyncMock.mockImplementation((command: string, args: unknown) => {
            if (command === 'powershell') {
                const table = rootProcessTableResult(args);
                if (table) return table;
                return { status: 0, stdout: Buffer.from(`${rootMarker}\n`) };
            }
            alive = false;
            return { status: 0 };
        });

        await expect(killProcess(123, false, rootMarker)).resolves.toBe(true);

        expect(taskkillCalls()).toHaveLength(1);
        expect(taskkillCalls()[0]?.[1]).toEqual(expect.arrayContaining(['/T', '/PID', '123']));
        expect(taskkillCalls()[0]?.[2]).toHaveProperty('timeout');
    });

    it('returns false when the root exits but a tracked descendant generation remains', async () => {
        const alive = new Set([123, 456]);
        vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
            if (alive.has(pid)) return true;
            return processExited();
        }) as typeof process.kill);
        spawnSyncMock.mockImplementation((command: string, args: string[]) => {
            if (command === 'powershell') {
                if (powershellScript(args).includes('ParentProcessId')) {
                    return {
                        status: 0,
                        stdout: processTable([
                            { pid: 123, parentPid: 1, marker: rootMarker },
                            { pid: 456, parentPid: 123, marker: childMarker }
                        ])
                    };
                }
                const pid = powershellScript(args).includes('456') ? 456 : 123;
                const marker = pid === 456 ? childMarker : rootMarker;
                return { status: 0, stdout: Buffer.from(`${marker}\n`) };
            }
            alive.delete(123);
            return { status: 0 };
        });

        const result = killProcess(123, false, rootMarker);
        await vi.advanceTimersByTimeAsync(3_000);

        await expect(result).resolves.toBe(false);
        expect(alive.has(456)).toBe(true);
    });

    it('returns true only after the root and tracked descendant generations exit', async () => {
        const alive = new Set([123, 456]);
        vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
            if (alive.has(pid)) return true;
            return processExited();
        }) as typeof process.kill);
        spawnSyncMock.mockImplementation((command: string, args: string[]) => {
            if (command === 'powershell') {
                if (powershellScript(args).includes('ParentProcessId')) {
                    return {
                        status: 0,
                        stdout: processTable([
                            { pid: 123, parentPid: 1, marker: rootMarker },
                            { pid: 456, parentPid: 123, marker: childMarker }
                        ])
                    };
                }
                const pid = powershellScript(args).includes('456') ? 456 : 123;
                const marker = pid === 456 ? childMarker : rootMarker;
                return { status: 0, stdout: Buffer.from(`${marker}\n`) };
            }
            alive.delete(123);
            setTimeout(() => alive.delete(456), 100);
            return { status: 0 };
        });

        const result = killProcess(123, false, rootMarker);
        await vi.advanceTimersByTimeAsync(100);

        await expect(result).resolves.toBe(true);
    });

    it('tracks a descendant generation that appears after taskkill starts', async () => {
        const alive = new Set([123, 456]);
        let tableReads = 0;
        vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
            if (alive.has(pid)) return true;
            return processExited();
        }) as typeof process.kill);
        spawnSyncMock.mockImplementation((command: string, args: string[]) => {
            if (command === 'powershell') {
                if (powershellScript(args).includes('ParentProcessId')) {
                    tableReads += 1;
                    return {
                        status: 0,
                        stdout: processTable([
                            { pid: 123, parentPid: 1, marker: rootMarker },
                            ...(tableReads >= 3
                                ? [{ pid: 456, parentPid: 123, marker: childMarker }]
                                : [])
                        ])
                    };
                }
                const marker = powershellScript(args).includes('456')
                    ? childMarker
                    : rootMarker;
                return { status: 0, stdout: Buffer.from(`${marker}\n`) };
            }
            alive.delete(123);
            return { status: 0 };
        });

        const result = killProcess(123, false, rootMarker);
        await vi.advanceTimersByTimeAsync(3_000);

        await expect(result).resolves.toBe(false);
        expect(alive.has(456)).toBe(true);
        expect(tableReads).toBeGreaterThanOrEqual(3);
    });

    it('does not count a newly discovered but already exited descendant as an empty scan', async () => {
        const handoffMarker = '2026-08-20T08:00:02.1234560Z';
        const alive = new Set([123, 789]);
        let tableReads = 0;
        vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
            if (alive.has(pid)) return true;
            return processExited();
        }) as typeof process.kill);
        spawnSyncMock.mockImplementation((command: string, args: string[]) => {
            if (command === 'powershell') {
                if (powershellScript(args).includes('ParentProcessId')) {
                    tableReads += 1;
                    return {
                        status: 0,
                        stdout: processTable([
                            { pid: 123, parentPid: 1, marker: rootMarker },
                            ...(tableReads >= 3
                                ? [{ pid: 456, parentPid: 123, marker: childMarker }]
                                : []),
                            ...(tableReads >= 4
                                ? [{ pid: 789, parentPid: 456, marker: handoffMarker }]
                                : [])
                        ])
                    };
                }
                const script = powershellScript(args);
                const marker = script.includes('789')
                    ? handoffMarker
                    : script.includes('456') ? childMarker : rootMarker;
                return { status: 0, stdout: Buffer.from(`${marker}\n`) };
            }
            alive.delete(123);
            return { status: 0 };
        });

        const result = killProcess(123, false, rootMarker);
        await vi.advanceTimersByTimeAsync(3_000);

        await expect(result).resolves.toBe(false);
        expect(alive.has(789)).toBe(true);
        expect(tableReads).toBeGreaterThanOrEqual(4);
    });

    it('fails closed when a same-millisecond child predates its parent', async () => {
        const newerRootMarker = '2026-08-20T08:00:00.1239000Z';
        const olderChildMarker = '2026-08-20T08:00:00.1231000Z';
        vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);
        spawnSyncMock.mockImplementation((command: string, args: string[]) => {
            if (command === 'powershell') {
                if (powershellScript(args).includes('ParentProcessId')) {
                    return {
                        status: 0,
                        stdout: processTable([
                            { pid: 123, parentPid: 1, marker: newerRootMarker },
                            { pid: 456, parentPid: 123, marker: olderChildMarker }
                        ])
                    };
                }
                const marker = powershellScript(args).includes('456')
                    ? olderChildMarker
                    : newerRootMarker;
                return { status: 0, stdout: Buffer.from(`${marker}\n`) };
            }
            return { status: 1 };
        });

        await expect(killProcess(123, false, newerRootMarker)).resolves.toBe(false);

        expect(taskkillCalls()).toHaveLength(0);
    });

    it('fails closed when a Windows descendant marker is not canonical', async () => {
        const malformedChildMarker = '2026-08-20T08:00:01.123Z';
        vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);
        spawnSyncMock.mockImplementation((command: string, args: string[]) => {
            if (command === 'powershell') {
                if (powershellScript(args).includes('ParentProcessId')) {
                    return {
                        status: 0,
                        stdout: processTable([
                            { pid: 123, parentPid: 1, marker: rootMarker },
                            { pid: 456, parentPid: 123, marker: malformedChildMarker }
                        ])
                    };
                }
                const marker = powershellScript(args).includes('456')
                    ? malformedChildMarker
                    : rootMarker;
                return { status: 0, stdout: Buffer.from(`${marker}\n`) };
            }
            return { status: 1 };
        });

        await expect(killProcess(123, false, rootMarker)).resolves.toBe(false);

        expect(taskkillCalls()).toHaveLength(0);
    });

    it('fails closed when the complete Windows process tree cannot be enumerated', async () => {
        vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);
        spawnSyncMock.mockImplementation((command: string, args: string[]) => {
            if (command === 'powershell') {
                if (powershellScript(args).includes('ParentProcessId')) {
                    return { status: 1, stdout: Buffer.alloc(0) };
                }
                return { status: 0, stdout: Buffer.from(`${rootMarker}\n`) };
            }
            if (command === 'wmic') return { status: 1, stdout: Buffer.alloc(0) };
            return { status: 0 };
        });

        const result = killProcess(123, false, rootMarker);
        await vi.advanceTimersByTimeAsync(3_000);

        await expect(result).resolves.toBe(false);

        expect(taskkillCalls()).toHaveLength(0);
    });

    it('uses the WMIC process-table fallback with valid system PID zero records', async () => {
        const alive = new Set([123]);
        vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
            if (alive.has(pid)) return true;
            return processExited();
        }) as typeof process.kill);
        spawnSyncMock.mockImplementation((command: string, args: string[]) => {
            if (command === 'powershell') {
                if (powershellScript(args).includes('ParentProcessId')) {
                    return { status: 1, stdout: Buffer.alloc(0) };
                }
                return { status: 0, stdout: Buffer.from(`${rootMarker}\n`) };
            }
            if (command === 'wmic') {
                return {
                    status: 0,
                    stdout: wmicProcessTable([
                        {
                            pid: 0,
                            parentPid: 0,
                            creationDate: '20260820070000.123456+000'
                        },
                        {
                            pid: 123,
                            parentPid: 1,
                            creationDate: '20260820080000.123456+000'
                        }
                    ])
                };
            }
            alive.delete(123);
            return { status: 0 };
        });

        await expect(killProcess(123, false, rootMarker)).resolves.toBe(true);

        expect(taskkillCalls()).toHaveLength(1);
        expect(spawnSyncMock.mock.calls.some(([command]) => command === 'wmic')).toBe(true);
    });

    it.each(['powershell', 'wmic'] as const)(
        'ignores an unrelated %s process whose creation marker is unavailable',
        async (source) => {
            const alive = new Set([123]);
            vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
                if (alive.has(pid)) return true;
                return processExited();
            }) as typeof process.kill);
            spawnSyncMock.mockImplementation((command: string, args: string[]) => {
                if (command === 'powershell') {
                    if (powershellScript(args).includes('ParentProcessId')) {
                        if (source === 'wmic') return { status: 1, stdout: Buffer.alloc(0) };
                        return {
                            status: 0,
                            stdout: processTable([
                                { pid: 123, parentPid: 1, marker: rootMarker },
                                { pid: 999, parentPid: 1, marker: '' }
                            ])
                        };
                    }
                    return { status: 0, stdout: Buffer.from(`${rootMarker}\n`) };
                }
                if (command === 'wmic') {
                    return {
                        status: 0,
                        stdout: wmicProcessTable([
                            {
                                pid: 123,
                                parentPid: 1,
                                creationDate: '20260820080000.123456+000'
                            },
                            { pid: 999, parentPid: 1, creationDate: '' }
                        ])
                    };
                }
                alive.delete(123);
                return { status: 0 };
            });

            await expect(killProcess(123, false, rootMarker)).resolves.toBe(true);

            expect(taskkillCalls()).toHaveLength(1);
        }
    );

    it.each(['powershell', 'wmic'] as const)(
        'fails closed when a %s descendant creation marker is unavailable',
        async (source) => {
            vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);
            spawnSyncMock.mockImplementation((command: string, args: string[]) => {
                if (command === 'powershell') {
                    if (powershellScript(args).includes('ParentProcessId')) {
                        if (source === 'wmic') return { status: 1, stdout: Buffer.alloc(0) };
                        return {
                            status: 0,
                            stdout: processTable([
                                { pid: 123, parentPid: 1, marker: rootMarker },
                                { pid: 456, parentPid: 123, marker: '' }
                            ])
                        };
                    }
                    return { status: 0, stdout: Buffer.from(`${rootMarker}\n`) };
                }
                if (command === 'wmic') {
                    return {
                        status: 0,
                        stdout: wmicProcessTable([
                            {
                                pid: 123,
                                parentPid: 1,
                                creationDate: '20260820080000.123456+000'
                            },
                            { pid: 456, parentPid: 123, creationDate: '' }
                        ])
                    };
                }
                return { status: 0 };
            });

            await expect(killProcess(123, false, rootMarker)).resolves.toBe(false);

            expect(taskkillCalls()).toHaveLength(0);
            if (source === 'powershell') {
                expect(spawnSyncMock.mock.calls.some(([command]) => command === 'wmic')).toBe(false);
            }
        }
    );

    it('fails closed when a WMIC descendant row has incomplete topology', async () => {
        const alive = new Set([123]);
        vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
            if (alive.has(pid)) return true;
            return processExited();
        }) as typeof process.kill);
        spawnSyncMock.mockImplementation((command: string, args: string[]) => {
            if (command === 'powershell') {
                if (powershellScript(args).includes('ParentProcessId')) {
                    return { status: 1, stdout: Buffer.alloc(0) };
                }
                return { status: 0, stdout: Buffer.from(`${rootMarker}\n`) };
            }
            if (command === 'wmic') {
                return {
                    status: 0,
                    stdout: Buffer.from([
                        'CreationDate=20260820080000.123456+000',
                        'ParentProcessId=1',
                        'ProcessId=123',
                        '',
                        'CreationDate=20260820080001.123456+000',
                        'ParentProcessId=123'
                    ].join('\r\n'))
                };
            }
            alive.delete(123);
            return { status: 0 };
        });

        await expect(killProcess(123, false, rootMarker)).resolves.toBe(false);

        expect(taskkillCalls()).toHaveLength(0);
    });

    it('fails closed when the expected generation exits before taskkill starts', async () => {
        let aliveChecks = 0;
        vi.spyOn(process, 'kill').mockImplementation((() => {
            aliveChecks += 1;
            if (aliveChecks < 4) return true;
            return processExited();
        }) as typeof process.kill);

        await expect(killProcess(123, false, rootMarker)).resolves.toBe(false);

        expect(taskkillCalls()).toHaveLength(0);
    });

    it('fails closed when taskkill returns nonzero and the root PID disappears', async () => {
        let alive = true;
        vi.spyOn(process, 'kill').mockImplementation((() => {
            if (alive) return true;
            return processExited();
        }) as typeof process.kill);
        spawnSyncMock.mockImplementation((command: string, args: unknown) => {
            if (command === 'powershell') {
                const table = rootProcessTableResult(args);
                if (table) return table;
                return { status: 0, stdout: Buffer.from(`${rootMarker}\n`) };
            }
            alive = false;
            return { status: 1 };
        });

        await expect(killProcess(123, false, rootMarker)).resolves.toBe(false);

        expect(taskkillCalls()).toHaveLength(1);
    });

    it('fails closed when taskkill errors and the root PID disappears', async () => {
        let alive = true;
        vi.spyOn(process, 'kill').mockImplementation((() => {
            if (alive) return true;
            return processExited();
        }) as typeof process.kill);
        spawnSyncMock.mockImplementation((command: string, args: unknown) => {
            if (command === 'powershell') {
                const table = rootProcessTableResult(args);
                if (table) return table;
                return { status: 0, stdout: Buffer.from(`${rootMarker}\n`) };
            }
            alive = false;
            return { status: null, error: new Error('taskkill failed') };
        });

        await expect(killProcess(123, false, rootMarker)).resolves.toBe(false);

        expect(taskkillCalls()).toHaveLength(1);
    });

    it('force-kills the same generation when graceful taskkill stalls', async () => {
        let alive = true;
        vi.spyOn(process, 'kill').mockImplementation((() => {
            if (alive) return true;
            return processExited();
        }) as typeof process.kill);
        spawnSyncMock.mockImplementation((command: string, args: string[]) => {
            if (command === 'powershell') {
                const table = rootProcessTableResult(args);
                if (table) return table;
                return { status: 0, stdout: Buffer.from(`${rootMarker}\n`) };
            }
            if (args.includes('/F')) alive = false;
            return { status: 0 };
        });

        const result = killProcess(123, false, rootMarker);
        await vi.advanceTimersByTimeAsync(3_000);

        await expect(result).resolves.toBe(true);
        expect(taskkillCalls()).toHaveLength(2);
        expect(taskkillCalls()[1]?.[1]).toEqual(
            expect.arrayContaining(['/F', '/T', '/PID', '123'])
        );
    });

    it('returns false when successful graceful and forced taskkill leave the generation alive', async () => {
        vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);

        const result = killProcess(123, false, rootMarker);
        await vi.advanceTimersByTimeAsync(3_000);

        await expect(result).resolves.toBe(false);
        expect(taskkillCalls()).toHaveLength(2);
        expect(taskkillCalls()[1]?.[1]).toContain('/F');
    });

    it('fails closed when forced taskkill fails and the root PID disappears', async () => {
        let alive = true;
        vi.spyOn(process, 'kill').mockImplementation((() => {
            if (alive) return true;
            return processExited();
        }) as typeof process.kill);
        spawnSyncMock.mockImplementation((command: string, args: string[]) => {
            if (command === 'powershell') {
                const table = rootProcessTableResult(args);
                if (table) return table;
                return { status: 0, stdout: Buffer.from(`${rootMarker}\n`) };
            }
            if (args.includes('/F')) {
                alive = false;
                return { status: 1 };
            }
            return { status: 0 };
        });

        const result = killProcess(123, false, rootMarker);
        await vi.advanceTimersByTimeAsync(3_000);

        await expect(result).resolves.toBe(false);
        expect(taskkillCalls()).toHaveLength(2);
        expect(taskkillCalls()[1]?.[1]).toContain('/F');
    });

    it('does not force-kill a reused PID', async () => {
        vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);
        let markerReads = 0;
        spawnSyncMock.mockImplementation((command: string, args: unknown) => {
            if (command === 'powershell') {
                const table = rootProcessTableResult(args);
                if (table) return table;
                markerReads += 1;
                return {
                    status: 0,
                    stdout: Buffer.from(markerReads === 1
                        ? `${rootMarker}\n`
                        : `${childMarker}\n`)
                };
            }
            return { status: 0 };
        });

        const result = killProcess(123, false, rootMarker);
        await vi.advanceTimersByTimeAsync(2_000);

        await expect(result).resolves.toBe(true);
        expect(taskkillCalls()).toHaveLength(1);
    });

    it('fails closed when the current generation cannot be read', async () => {
        vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);
        spawnSyncMock.mockReturnValue({ status: 1, stdout: Buffer.alloc(0) });

        await expect(killProcess(123, false, rootMarker)).resolves.toBe(false);

        expect(taskkillCalls()).toHaveLength(0);
    });

    it('does not taskkill when a tracked descendant liveness probe is unknown', async () => {
        vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
            if (pid === 456) {
                throw Object.assign(new Error('access denied'), { code: 'EPERM' });
            }
            return true;
        }) as typeof process.kill);
        spawnSyncMock.mockImplementation((command: string, args: string[]) => {
            if (command === 'powershell') {
                if (powershellScript(args).includes('ParentProcessId')) {
                    return {
                        status: 0,
                        stdout: processTable([
                            { pid: 123, parentPid: 1, marker: rootMarker },
                            { pid: 456, parentPid: 123, marker: childMarker }
                        ])
                    };
                }
                const marker = powershellScript(args).includes('456')
                    ? childMarker
                    : rootMarker;
                return { status: 0, stdout: Buffer.from(`${marker}\n`) };
            }
            return { status: 0 };
        });

        const result = killProcess(123, false, rootMarker);
        await vi.advanceTimersByTimeAsync(3_000);

        await expect(result).resolves.toBe(false);
        expect(taskkillCalls()).toHaveLength(0);
    });

    it('bounds Windows commands by the caller deadline', async () => {
        const alive = new Set([123]);
        vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
            if (alive.has(pid)) return true;
            return processExited();
        }) as typeof process.kill);
        spawnSyncMock.mockImplementation((command: string, args: unknown) => {
            if (command === 'powershell') {
                const table = rootProcessTableResult(args);
                if (table) return table;
                return { status: 0, stdout: Buffer.from(`${rootMarker}\n`) };
            }
            alive.delete(123);
            return { status: 0 };
        });

        await expect(
            killProcess(123, false, rootMarker, Date.now() + 100)
        ).resolves.toBe(true);

        const windowsCalls = spawnSyncMock.mock.calls.filter(([command]) => (
            command === 'powershell' || command === 'taskkill'
        ));
        for (const [, , options] of windowsCalls) {
            expect((options as { timeout: number }).timeout).toBeLessThanOrEqual(100);
        }
    });

    it('forwards the generation marker and deadline from a child process', async () => {
        vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);
        spawnSyncMock.mockImplementation((command: string) => {
            if (command === 'powershell') {
                return { status: 0, stdout: Buffer.from('replacement-marker\n') };
            }
            return { status: 0 };
        });
        const child = { pid: 123 } as ChildProcess;

        await expect(
            killProcessByChildProcess(child, false, rootMarker, Date.now() + 100)
        ).resolves.toBe(false);

        const powershellCall = spawnSyncMock.mock.calls.find(([command]) => command === 'powershell');
        expect((powershellCall?.[2] as { timeout: number }).timeout).toBeLessThanOrEqual(100);
        expect(taskkillCalls()).toHaveLength(0);
    });

    it('normalizes a WMIC fallback marker to the PowerShell format', () => {
        vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);
        spawnSyncMock.mockImplementation((command: string) => {
            if (command === 'powershell') {
                return { status: 1, stdout: Buffer.alloc(0) };
            }
            return {
                status: 0,
                stdout: Buffer.from('CreationDate=20260820080000.123456+000\r\n')
            };
        });

        expect(getProcessStartMarker(123)).toBe(rootMarker);
    });

    it('fails closed when the expected generation is already absent', async () => {
        vi.spyOn(process, 'kill').mockImplementation((() => processExited()) as typeof process.kill);

        await expect(killProcess(123, false, rootMarker)).resolves.toBe(false);
        expect(spawnSyncMock).not.toHaveBeenCalled();
    });
});

describe.skipIf(process.platform === 'win32')('strict POSIX token ownership', () => {
    const originalMarker = 'Thu Aug 20 08:00:00 2026';
    const replacementMarker = 'Thu Aug 20 08:00:01 2026';
    const psColumns = 'pid=,uid=,ppid=,pgid=,lstart=,command=';
    const uid = process.getuid?.() ?? 1_000;
    let tokenSequence = 0;
    let ownershipToken: string;
    let child: ChildProcess;

    function ownershipTable(options?: {
        command?: string;
        marker?: string;
        processGroupId?: number;
        token?: string;
        uid?: number;
    }): Buffer {
        const environment = options?.token
            ? ` ${strictOwnershipEnv}=${options.token}`
            : '';
        return Buffer.from(
            `456 ${options?.uid ?? uid} 1 ${options?.processGroupId ?? 123} `
                + `${options?.marker ?? originalMarker} `
                + `${options?.command ?? 'node app.js'}${environment}\n`
        );
    }

    function isPsTable(args: string[], modifier: 'axeww' | 'axww'): boolean {
        return args.length === 3
            && args[0] === modifier
            && args[1] === '-o'
            && args[2] === psColumns;
    }

    function installProcessSignalMock(options?: { exitOnDirectSignal?: boolean }): string[] {
        let ownedProcessAlive = true;
        const signals: string[] = [];
        vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
            if (signal === 0) {
                if (pid === 123) return processExited();
                if (pid === 456 && !ownedProcessAlive) return processExited();
                return true;
            }
            signals.push(`${pid}:${String(signal)}`);
            if (pid === 456 && options?.exitOnDirectSignal) ownedProcessAlive = false;
            return true;
        }) as typeof process.kill);
        return signals;
    }

    beforeEach(() => {
        Object.defineProperty(process, 'platform', {
            ...platformDescriptor,
            value: 'darwin'
        });
        tokenSequence += 1;
        ownershipToken = `strict-token-${tokenSequence}`;
        child = { pid: 123 } as ChildProcess;
        spawnSyncMock.mockReset();
    });

    afterEach(() => {
        Object.defineProperty(process, 'platform', platformDescriptor);
        vi.restoreAllMocks();
    });

    it('signals only a same-UID token found in the enriched command suffix', async () => {
        const signals = installProcessSignalMock({ exitOnDirectSignal: true });
        spawnSyncMock.mockImplementation((command: string, args: string[]) => {
            if (command !== 'ps') return { status: 1, stdout: Buffer.alloc(0) };
            if (args[0] === '-p') {
                return { status: 0, stdout: Buffer.from(`${originalMarker}\n`) };
            }
            if (isPsTable(args, 'axeww')) {
                return { status: 0, stdout: ownershipTable({ token: ownershipToken }) };
            }
            if (isPsTable(args, 'axww')) {
                return { status: 0, stdout: ownershipTable() };
            }
            return { status: 1, stdout: Buffer.alloc(0) };
        });

        await expect(killProcessByChildProcess(
            child,
            false,
            originalMarker,
            Date.now() + 200,
            true,
            ownershipToken
        )).resolves.toBe(true);

        expect(signals).toEqual(['-123:SIGTERM', '456:SIGTERM']);
        expect(spawnSyncMock).toHaveBeenCalledWith(
            'ps',
            ['axeww', '-o', psColumns],
            expect.objectContaining({ stdio: 'pipe' })
        );
        expect(spawnSyncMock).toHaveBeenCalledWith(
            'ps',
            ['axww', '-o', psColumns],
            expect.objectContaining({ stdio: 'pipe' })
        );
    });

    const rejectedOwnershipCases: Array<[
        string,
        () => { token: string; uid?: number }
    ]> = [
        ['wrong token', () => ({ token: `${ownershipToken}-wrong` })],
        ['different UID', () => ({ token: ownershipToken, uid: uid + 1 })]
    ];

    it.each(rejectedOwnershipCases)('leaves a %s process untouched', async (
        _case,
        enrichedOptions
    ) => {
        const signals = installProcessSignalMock();
        spawnSyncMock.mockImplementation((command: string, args: string[]) => {
            if (command !== 'ps') return { status: 1, stdout: Buffer.alloc(0) };
            if (isPsTable(args, 'axeww')) {
                return { status: 0, stdout: ownershipTable(enrichedOptions()) };
            }
            if (isPsTable(args, 'axww')) {
                const options = enrichedOptions();
                return { status: 0, stdout: ownershipTable({ uid: options.uid }) };
            }
            return { status: 1, stdout: Buffer.alloc(0) };
        });

        await expect(killProcessByChildProcess(
            child,
            false,
            originalMarker,
            Date.now() + 200,
            true,
            ownershipToken
        )).resolves.toBe(true);

        expect(signals).toEqual([]);
    });

    it('does not treat a token appearing only in argv as ownership', async () => {
        const signals = installProcessSignalMock();
        const commandLine = `node app.js ${strictOwnershipEnv}=${ownershipToken}`;
        spawnSyncMock.mockImplementation((command: string, args: string[]) => {
            if (command !== 'ps') return { status: 1, stdout: Buffer.alloc(0) };
            if (isPsTable(args, 'axeww') || isPsTable(args, 'axww')) {
                return {
                    status: 0,
                    stdout: ownershipTable({ command: commandLine })
                };
            }
            return { status: 1, stdout: Buffer.alloc(0) };
        });

        await expect(killProcessByChildProcess(
            child,
            false,
            originalMarker,
            Date.now() + 200,
            true,
            ownershipToken
        )).resolves.toBe(true);

        expect(signals).toEqual([]);
    });

    it('does not signal a replaced token-owned PID generation', async () => {
        const signals = installProcessSignalMock();
        spawnSyncMock.mockImplementation((command: string, args: string[]) => {
            if (command === 'ps' && args.includes('-p')) {
                return { status: 0, stdout: Buffer.from(`${replacementMarker}\n`) };
            }
            if (command === 'ps' && isPsTable(args, 'axeww')) {
                return { status: 0, stdout: ownershipTable({ token: ownershipToken }) };
            }
            if (command === 'ps' && isPsTable(args, 'axww')) {
                return { status: 0, stdout: ownershipTable() };
            }
            return { status: 1, stdout: Buffer.alloc(0) };
        });

        await expect(killProcessByChildProcess(
            child,
            false,
            originalMarker,
            Date.now() + 100,
            true,
            ownershipToken
        )).resolves.toBe(true);

        expect(signals).toEqual([]);
    });

    it('does not signal a same-marker replacement missing the ownership token', async () => {
        const signals = installProcessSignalMock();
        let includeToken = true;
        let markerReads = 0;
        spawnSyncMock.mockImplementation((command: string, args: string[]) => {
            if (command !== 'ps') return { status: 1, stdout: Buffer.alloc(0) };
            if (args[0] === '-p') {
                markerReads += 1;
                if (markerReads === 2) includeToken = false;
                return { status: 0, stdout: Buffer.from(`${originalMarker}\n`) };
            }
            if (isPsTable(args, 'axeww')) {
                return {
                    status: 0,
                    stdout: ownershipTable({
                        processGroupId: 789,
                        ...(includeToken ? { token: ownershipToken } : {})
                    })
                };
            }
            if (isPsTable(args, 'axww')) {
                return {
                    status: 0,
                    stdout: ownershipTable({ processGroupId: 789 })
                };
            }
            return { status: 1, stdout: Buffer.alloc(0) };
        });

        await expect(killProcessByChildProcess(
            child,
            false,
            originalMarker,
            Date.now() + 200,
            true,
            ownershipToken
        )).resolves.toBe(false);

        expect(signals).toEqual([]);
    });

    it('revalidates the current process group before group signaling', async () => {
        const signals = installProcessSignalMock({ exitOnDirectSignal: true });
        let processGroupId = 123;
        let markerReads = 0;
        spawnSyncMock.mockImplementation((command: string, args: string[]) => {
            if (command !== 'ps') return { status: 1, stdout: Buffer.alloc(0) };
            if (args[0] === '-p') {
                markerReads += 1;
                if (markerReads === 2) processGroupId = 789;
                return { status: 0, stdout: Buffer.from(`${originalMarker}\n`) };
            }
            if (isPsTable(args, 'axeww')) {
                return {
                    status: 0,
                    stdout: ownershipTable({ processGroupId, token: ownershipToken })
                };
            }
            if (isPsTable(args, 'axww')) {
                return { status: 0, stdout: ownershipTable({ processGroupId }) };
            }
            return { status: 1, stdout: Buffer.alloc(0) };
        });

        await expect(killProcessByChildProcess(
            child,
            false,
            originalMarker,
            Date.now() + 200,
            true,
            ownershipToken
        )).resolves.toBe(true);

        expect(signals).toEqual(['456:SIGTERM']);
    });

    it('fails closed before signaling when a token-owned identity is unknown', async () => {
        const signals = installProcessSignalMock();
        spawnSyncMock.mockImplementation((command: string, args: string[]) => {
            if (command === 'ps' && args.includes('-p')) {
                return { status: 1, stdout: Buffer.alloc(0) };
            }
            if (command === 'ps' && isPsTable(args, 'axeww')) {
                return { status: 0, stdout: ownershipTable({ token: ownershipToken }) };
            }
            if (command === 'ps' && isPsTable(args, 'axww')) {
                return { status: 0, stdout: ownershipTable() };
            }
            return { status: 1, stdout: Buffer.alloc(0) };
        });

        await expect(killProcessByChildProcess(
            child,
            false,
            originalMarker,
            Date.now() + 100,
            true,
            ownershipToken
        )).resolves.toBe(false);

        expect(signals).toEqual([]);
    });

    it('retains a known generation across cleanup retries', async () => {
        const signals = installProcessSignalMock();
        let includeToken = true;
        let markerAvailable = false;
        spawnSyncMock.mockImplementation((command: string, args: string[]) => {
            if (command !== 'ps') return { status: 1, stdout: Buffer.alloc(0) };
            if (args[0] === '-p') {
                return markerAvailable
                    ? { status: 0, stdout: Buffer.from(`${originalMarker}\n`) }
                    : { status: 1, stdout: Buffer.alloc(0) };
            }
            if (isPsTable(args, 'axeww')) {
                return {
                    status: 0,
                    stdout: ownershipTable(includeToken ? { token: ownershipToken } : undefined)
                };
            }
            if (isPsTable(args, 'axww')) {
                return { status: 0, stdout: ownershipTable() };
            }
            return { status: 1, stdout: Buffer.alloc(0) };
        });

        await expect(killProcessByChildProcess(
            child,
            false,
            originalMarker,
            Date.now() + 200,
            true,
            ownershipToken
        )).resolves.toBe(false);

        includeToken = false;
        markerAvailable = true;
        await expect(killProcessByChildProcess(
            child,
            false,
            originalMarker,
            Date.now() + 200,
            true,
            ownershipToken
        )).resolves.toBe(false);

        expect(signals).toEqual([]);
    });

    it('does not count an observed generation that exits during identity handoff as empty', async () => {
        const signals: string[] = [];
        let tableScan = 0;
        const table = (pid: number, includeToken: boolean): Buffer => Buffer.from(
            `${pid} ${uid} 1 123 ${originalMarker} node app.js`
                + `${includeToken ? ` ${strictOwnershipEnv}=${ownershipToken}` : ''}\n`
        );
        vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
            if (signal === 0) {
                if (pid === 123) return processExited();
                if (pid === 789) {
                    throw Object.assign(new Error('identity denied'), { code: 'EACCES' });
                }
                return true;
            }
            signals.push(`${pid}:${String(signal)}`);
            return true;
        }) as typeof process.kill);
        spawnSyncMock.mockImplementation((command: string, args: string[]) => {
            if (command !== 'ps') return { status: 1, stdout: Buffer.alloc(0) };
            if (args[0] === '-p') {
                return { status: 0, stdout: Buffer.from(`${replacementMarker}\n`) };
            }
            if (isPsTable(args, 'axeww')) {
                tableScan += 1;
                if (tableScan <= 2) return { status: 0, stdout: table(456, false) };
                if (tableScan === 3) return { status: 0, stdout: table(456, true) };
                return { status: 0, stdout: table(789, true) };
            }
            if (isPsTable(args, 'axww')) {
                return { status: 0, stdout: table(tableScan >= 4 ? 789 : 456, false) };
            }
            return { status: 1, stdout: Buffer.alloc(0) };
        });

        await expect(killProcessByChildProcess(
            child,
            false,
            originalMarker,
            Date.now() + 300,
            true,
            ownershipToken
        )).resolves.toBe(false);

        expect(tableScan).toBeGreaterThanOrEqual(4);
        expect(signals).toEqual([]);
    });

    it('rejects a different token on a retry for the same child', async () => {
        const signals = installProcessSignalMock();
        spawnSyncMock.mockImplementation((command: string, args: string[]) => {
            if (command !== 'ps') return { status: 1, stdout: Buffer.alloc(0) };
            if (args[0] === '-p') return { status: 1, stdout: Buffer.alloc(0) };
            if (isPsTable(args, 'axeww')) {
                return { status: 0, stdout: ownershipTable({ token: ownershipToken }) };
            }
            if (isPsTable(args, 'axww')) {
                return { status: 0, stdout: ownershipTable() };
            }
            return { status: 1, stdout: Buffer.alloc(0) };
        });

        await expect(killProcessByChildProcess(
            child,
            false,
            originalMarker,
            Date.now() + 200,
            true,
            ownershipToken
        )).resolves.toBe(false);
        spawnSyncMock.mockClear();

        await expect(killProcessByChildProcess(
            child,
            false,
            originalMarker,
            Date.now() + 200,
            true,
            `${ownershipToken}-replacement`
        )).resolves.toBe(false);

        expect(spawnSyncMock).not.toHaveBeenCalled();
        expect(signals).toEqual([]);
    });

    it('does not signal a recycled process group with no token-owned generation', async () => {
        const signals = installProcessSignalMock();
        spawnSyncMock.mockImplementation((command: string, args: string[]) => {
            if (command === 'ps' && (isPsTable(args, 'axeww') || isPsTable(args, 'axww'))) {
                return { status: 0, stdout: ownershipTable() };
            }
            return { status: 1, stdout: Buffer.alloc(0) };
        });

        await expect(killProcessByChildProcess(
            child,
            false,
            originalMarker,
            Date.now() + 100,
            true,
            ownershipToken
        )).resolves.toBe(true);

        expect(signals).toEqual([]);
    });

    it('fails closed when ownership enumeration fails', async () => {
        const signals = installProcessSignalMock();
        spawnSyncMock.mockReturnValue({ status: 1, stdout: Buffer.alloc(0) });

        await expect(killProcessByChildProcess(
            child,
            false,
            originalMarker,
            Date.now() + 200,
            true,
            ownershipToken
        )).resolves.toBe(false);

        expect(signals).toEqual([]);
    });

    it('does not enumerate or signal after the caller deadline', async () => {
        const signals = installProcessSignalMock();

        await expect(killProcessByChildProcess(
            child,
            false,
            originalMarker,
            Date.now() - 1,
            true,
            ownershipToken
        )).resolves.toBe(false);

        expect(spawnSyncMock).not.toHaveBeenCalled();
        expect(signals).toEqual([]);
    });

    it.each([
        ['process group', 123],
        ['individual process', 789]
    ])('does not signal a %s when its final identity probe consumes the deadline', async (
        _case,
        processGroupId
    ) => {
        const signals = installProcessSignalMock();
        const deadline = 10_100;
        let now = 10_000;
        let markerReads = 0;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        spawnSyncMock.mockImplementation((command: string, args: string[]) => {
            if (command !== 'ps') return { status: 1, stdout: Buffer.alloc(0) };
            if (args[0] === '-p') {
                markerReads += 1;
                if (markerReads === 2) now = deadline;
                return { status: 0, stdout: Buffer.from(`${originalMarker}\n`) };
            }
            if (isPsTable(args, 'axeww')) {
                return {
                    status: 0,
                    stdout: ownershipTable({ processGroupId, token: ownershipToken })
                };
            }
            if (isPsTable(args, 'axww')) {
                return { status: 0, stdout: ownershipTable({ processGroupId }) };
            }
            return { status: 1, stdout: Buffer.alloc(0) };
        });

        await expect(killProcessByChildProcess(
            child,
            false,
            originalMarker,
            deadline,
            true,
            ownershipToken
        )).resolves.toBe(false);

        expect(signals).toEqual([]);
    });

    it('bounds ownership enumeration by the caller deadline', async () => {
        installProcessSignalMock();
        spawnSyncMock.mockImplementation((command: string, args: string[]) => {
            if (command === 'ps' && (isPsTable(args, 'axeww') || isPsTable(args, 'axww'))) {
                return { status: 0, stdout: ownershipTable() };
            }
            return { status: 1, stdout: Buffer.alloc(0) };
        });

        await expect(killProcessByChildProcess(
            child,
            false,
            originalMarker,
            Date.now() + 100,
            true,
            ownershipToken
        )).resolves.toBe(true);

        const enumerationCalls = spawnSyncMock.mock.calls.filter(([, args]) => (
            Array.isArray(args) && (isPsTable(args, 'axeww') || isPsTable(args, 'axww'))
        ));
        expect(enumerationCalls.length).toBeGreaterThanOrEqual(4);
        expect(enumerationCalls.every(([, , options]) => (
            (options as { timeout: number }).timeout > 0
                && (options as { timeout: number }).timeout <= 100
        ))).toBe(true);
    });
});

describe.skipIf(process.platform !== 'linux')('strict Linux token ownership', () => {
    const rootStartMarker = 'linux:4000';
    const uid = process.getuid?.() ?? 1_000;
    let tokenSequence = 0;

    function linuxStat(pid: number, processGroupId: number, startTime: string): string {
        const fields = Array.from({ length: 20 }, () => '0');
        fields[0] = 'S';
        fields[1] = '1';
        fields[2] = String(processGroupId);
        fields[19] = startTime;
        return `${pid} (node) ${fields.join(' ')}`;
    }

    function installProcMock(options: {
        environment: () => Buffer;
        pid: number;
        processGroupId: number;
        startTime?: string;
    }): void {
        fsOverrides.readdirSync = (path) => {
            expect(path).toBe('/proc');
            return [String(options.pid)];
        };
        fsOverrides.statSync = (path) => {
            expect(path).toBe(`/proc/${options.pid}`);
            return { uid };
        };
        fsOverrides.readFileSync = (path) => {
            if (path === `/proc/${options.pid}/stat`) {
                return linuxStat(
                    options.pid,
                    options.processGroupId,
                    options.startTime ?? '4242'
                );
            }
            if (path === `/proc/${options.pid}/environ`) {
                return options.environment();
            }
            throw new Error(`Unexpected proc read: ${String(path)}`);
        };
    }

    beforeEach(() => {
        fsOverrides.readdirSync = null;
        fsOverrides.readFileSync = null;
        fsOverrides.statSync = null;
        spawnSyncMock.mockReset();
    });

    afterEach(() => {
        fsOverrides.readdirSync = null;
        fsOverrides.readFileSync = null;
        fsOverrides.statSync = null;
        vi.restoreAllMocks();
    });

    it('reads the precise Linux process start time from procfs', () => {
        installProcMock({
            environment: () => Buffer.alloc(0),
            pid: 123,
            processGroupId: 123,
            startTime: '7777'
        });
        vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);
        spawnSyncMock.mockReturnValue({
            status: 0,
            stdout: Buffer.from('Thu Aug 20 08:00:00 2026\n')
        });

        expect(getProcessStartMarker(123)).toBe('linux:7777');
        expect(spawnSyncMock).not.toHaveBeenCalled();
    });

    it('fails closed when a known owned generation makes its environment unreadable', async () => {
        tokenSequence += 1;
        const ownershipToken = `linux-known-token-${tokenSequence}`;
        const child = { pid: 123 } as ChildProcess;
        let environmentReadable = true;
        let identityKnown = false;
        let ownedProcessAlive = true;
        const signals: string[] = [];
        installProcMock({
            environment: () => {
                if (!environmentReadable) {
                    throw Object.assign(new Error('environment denied'), { code: 'EACCES' });
                }
                return Buffer.from(`${strictOwnershipEnv}=${ownershipToken}\0`);
            },
            pid: 456,
            processGroupId: 123
        });
        vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
            if (signal === 0) {
                if (pid === 123) return processExited();
                if (!ownedProcessAlive) return processExited();
                if (pid === 456 && !identityKnown) {
                    throw Object.assign(new Error('identity denied'), { code: 'EACCES' });
                }
                return true;
            }
            signals.push(`${pid}:${String(signal)}`);
            ownedProcessAlive = false;
            return true;
        }) as typeof process.kill);

        await expect(killProcessByChildProcess(
            child,
            false,
            rootStartMarker,
            Date.now() + 200,
            true,
            ownershipToken
        )).resolves.toBe(false);

        environmentReadable = false;
        identityKnown = true;
        await expect(killProcessByChildProcess(
            child,
            false,
            rootStartMarker,
            Date.now() + 200,
            true,
            ownershipToken
        )).resolves.toBe(false);

        expect(signals).toEqual([]);
    });

    it('retries a transiently unreadable new owned generation before failing closed', async () => {
        tokenSequence += 1;
        const ownershipToken = `linux-transient-token-${tokenSequence}`;
        const child = { pid: 123 } as ChildProcess;
        let environmentReads = 0;
        let ownedProcessAlive = true;
        const signals: string[] = [];
        installProcMock({
            environment: () => {
                environmentReads += 1;
                if (environmentReads === 1) {
                    throw Object.assign(new Error('environment denied'), { code: 'EACCES' });
                }
                return Buffer.from(`${strictOwnershipEnv}=${ownershipToken}\0`);
            },
            pid: 456,
            processGroupId: 123
        });
        vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
            if (signal === 0) {
                if (pid === 123 || (pid === 456 && !ownedProcessAlive)) return processExited();
                return true;
            }
            signals.push(`${pid}:${String(signal)}`);
            if (pid === 456) ownedProcessAlive = false;
            return true;
        }) as typeof process.kill);

        await expect(killProcessByChildProcess(
            child,
            false,
            rootStartMarker,
            Date.now() + 300,
            true,
            ownershipToken
        )).resolves.toBe(true);

        expect(environmentReads).toBeGreaterThan(1);
        expect(signals).toContain('456:SIGTERM');
    });

    it('does not lose a descendant spawned during Linux snapshot handoff', async () => {
        tokenSequence += 1;
        const ownershipToken = `linux-handoff-token-${tokenSequence}`;
        const child = { pid: 123 } as ChildProcess;
        let scan = 0;
        let handoffRecordReads = 0;
        const signals: string[] = [];
        fsOverrides.readdirSync = () => {
            scan += 1;
            if (scan === 1) return ['999'];
            if (scan === 2) return ['456'];
            return ['789'];
        };
        fsOverrides.statSync = () => ({ uid });
        fsOverrides.readFileSync = (path) => {
            if (path === '/proc/999/stat') return linuxStat(999, 999, '3000');
            if (path === '/proc/999/environ') return Buffer.alloc(0);
            if (path === '/proc/456/stat') {
                handoffRecordReads += 1;
                if (handoffRecordReads > 1) {
                    throw Object.assign(new Error('process exited'), { code: 'ENOENT' });
                }
                return linuxStat(456, 123, '4242');
            }
            if (path === '/proc/456/environ') {
                return Buffer.from(`${strictOwnershipEnv}=${ownershipToken}\0`);
            }
            if (path === '/proc/789/stat') return linuxStat(789, 789, '4243');
            if (path === '/proc/789/environ') {
                return Buffer.from(`${strictOwnershipEnv}=${ownershipToken}\0`);
            }
            throw new Error(`Unexpected proc read: ${String(path)}`);
        };
        vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
            if (signal === 0) {
                if (pid === 123 || pid === 456) return processExited();
                if (pid === 789) {
                    throw Object.assign(new Error('identity denied'), { code: 'EACCES' });
                }
                return true;
            }
            signals.push(`${pid}:${String(signal)}`);
            return true;
        }) as typeof process.kill);

        await expect(killProcessByChildProcess(
            child,
            false,
            rootStartMarker,
            Date.now() + 200,
            true,
            ownershipToken
        )).resolves.toBe(false);

        expect(scan).toBeGreaterThanOrEqual(3);
        expect(signals).toEqual([]);
    });

    it('does not signal a stale process group after a known process moves groups', async () => {
        tokenSequence += 1;
        const ownershipToken = `linux-moved-token-${tokenSequence}`;
        const child = { pid: 123 } as ChildProcess;
        let includeToken = true;
        let identityKnown = false;
        let ownedProcessAlive = true;
        let processGroupId = 123;
        const signals: string[] = [];
        installProcMock({
            environment: () => Buffer.from(includeToken
                ? `${strictOwnershipEnv}=${ownershipToken}\0`
                : ''),
            pid: 456,
            get processGroupId() {
                return processGroupId;
            }
        });
        vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
            if (signal === 0) {
                if (pid === 123) return processExited();
                if (!ownedProcessAlive) return processExited();
                if (pid === 456 && !identityKnown) {
                    throw Object.assign(new Error('identity denied'), { code: 'EACCES' });
                }
                return true;
            }
            signals.push(`${pid}:${String(signal)}`);
            if (pid === 456) ownedProcessAlive = false;
            return true;
        }) as typeof process.kill);

        await expect(killProcessByChildProcess(
            child,
            false,
            rootStartMarker,
            Date.now() + 200,
            true,
            ownershipToken
        )).resolves.toBe(false);

        includeToken = false;
        identityKnown = true;
        processGroupId = 789;
        await expect(killProcessByChildProcess(
            child,
            false,
            rootStartMarker,
            Date.now() + 200,
            true,
            ownershipToken
        )).resolves.toBe(true);

        expect(signals).toEqual(['456:SIGTERM']);
    });

    it('fails closed when the strict root environment is unreadable', async () => {
        tokenSequence += 1;
        const ownershipToken = `linux-root-token-${tokenSequence}`;
        const child = { pid: 123 } as ChildProcess;
        const signals: string[] = [];
        installProcMock({
            environment: () => {
                throw Object.assign(new Error('environment denied'), { code: 'EACCES' });
            },
            pid: 123,
            processGroupId: 123,
            startTime: '4000'
        });
        vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
            if (signal === 0) return true;
            signals.push(`${pid}:${String(signal)}`);
            return true;
        }) as typeof process.kill);

        await expect(killProcessByChildProcess(
            child,
            false,
            rootStartMarker,
            Date.now() + 200,
            true,
            ownershipToken
        )).resolves.toBe(false);

        expect(signals).toEqual([]);
    });

    it('ignores an unreadable unrelated same-UID environment', async () => {
        tokenSequence += 1;
        const ownershipToken = `linux-unrelated-token-${tokenSequence}`;
        const child = { pid: 123 } as ChildProcess;
        const signals: string[] = [];
        installProcMock({
            environment: () => {
                throw Object.assign(new Error('environment denied'), { code: 'EACCES' });
            },
            pid: 999,
            processGroupId: 999,
            startTime: '3000'
        });
        vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
            if (signal === 0) {
                if (pid === 123) return processExited();
                return true;
            }
            signals.push(`${pid}:${String(signal)}`);
            return true;
        }) as typeof process.kill);

        await expect(killProcessByChildProcess(
            child,
            false,
            rootStartMarker,
            Date.now() + 200,
            true,
            ownershipToken
        )).resolves.toBe(true);

        expect(signals).toEqual([]);
    });

    it('fails closed when an unreadable older PID changes generation during inspection', async () => {
        tokenSequence += 1;
        const ownershipToken = `linux-raced-token-${tokenSequence}`;
        const child = { pid: 123 } as ChildProcess;
        let environmentReads = 0;
        let statReads = 0;
        installProcMock({
            environment: () => {
                environmentReads += 1;
                if (environmentReads === 1) {
                    throw Object.assign(new Error('environment denied'), { code: 'EACCES' });
                }
                return Buffer.alloc(0);
            },
            pid: 999,
            processGroupId: 999,
            get startTime() {
                statReads += 1;
                return statReads === 1 ? '3000' : '5000';
            }
        });
        vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
            if (signal === 0) {
                if (pid === 123) return processExited();
                return true;
            }
            return true;
        }) as typeof process.kill);

        await expect(killProcessByChildProcess(
            child,
            false,
            rootStartMarker,
            Date.now() + 200,
            true,
            ownershipToken
        )).resolves.toBe(false);
    });
});

describe.skipIf(process.platform === 'win32')('strict POSIX process-group termination', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('does not resolve until the detached parent and descendant are both gone', async () => {
        const ownershipToken = `group-tree-${process.pid}-${Date.now()}`;
        const parent = spawnChild(process.execPath, ['-e', [
            "const { spawn } = require('node:child_process')",
            "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
            'console.log(child.pid)',
            'setInterval(() => {}, 1000)'
        ].join(';')], {
            detached: true,
            env: { ...process.env, [strictOwnershipEnv]: ownershipToken },
            stdio: ['ignore', 'pipe', 'ignore']
        });
        const rootStartMarker = requireProcessStartMarker(parent.pid!);
        try {
            const output = await once(parent.stdout!, 'data');
            const childPid = Number(output[0].toString().trim());

            await expect(killProcessByChildProcess(
                parent,
                false,
                rootStartMarker,
                Date.now() + 5_000,
                true,
                ownershipToken
            )).resolves.toBe(true);

            expect(isProcessAlive(parent.pid!)).toBe(false);
            expect(isProcessAlive(childPid)).toBe(false);
        } finally {
            try {
                process.kill(-parent.pid!, 'SIGKILL');
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
            }
            if (parent.exitCode === null && parent.signalCode === null) {
                await once(parent, 'exit');
            }
        }
    });

    it('terminates a token-owned setsid child while its parent is still alive', async () => {
        const ownershipToken = `setsid-live-root-${process.pid}-${Date.now()}`;
        const parent = spawnChild(process.execPath, ['-e', [
            "const { spawn } = require('node:child_process')",
            "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })",
            'child.unref()',
            'console.log(child.pid)',
            'setInterval(() => {}, 1000)'
        ].join(';')], {
            detached: true,
            env: { ...process.env, [strictOwnershipEnv]: ownershipToken },
            stdio: ['ignore', 'pipe', 'ignore']
        });
        const rootStartMarker = requireProcessStartMarker(parent.pid!);
        let childPid: number | null = null;

        try {
            const output = await once(parent.stdout!, 'data');
            childPid = Number(output[0].toString().trim());

            await expect(killProcessByChildProcess(
                parent,
                false,
                rootStartMarker,
                Date.now() + 5_000,
                true,
                ownershipToken
            )).resolves.toBe(true);

            expect(isProcessAlive(parent.pid!)).toBe(false);
            expect(isProcessAlive(childPid)).toBe(false);
        } finally {
            for (const processGroupId of [parent.pid!, childPid]) {
                if (processGroupId === null) continue;
                try {
                    process.kill(-processGroupId, 'SIGKILL');
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
                }
            }
            if (parent.exitCode === null && parent.signalCode === null) {
                await once(parent, 'exit');
            }
        }
    });

    it('terminates a surviving process group after its detached leader exits', async () => {
        const ownershipToken = `group-reparent-${process.pid}-${Date.now()}`;
        const parent = spawnChild(process.execPath, ['-e', [
            "const { spawn } = require('node:child_process')",
            "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
            'child.unref()',
            'console.log(child.pid)'
        ].join(';')], {
            detached: true,
            env: { ...process.env, [strictOwnershipEnv]: ownershipToken },
            stdio: ['ignore', 'pipe', 'ignore']
        });
        const rootStartMarker = requireProcessStartMarker(parent.pid!);
        try {
            const output = await once(parent.stdout!, 'data');
            const childPid = Number(output[0].toString().trim());
            if (parent.exitCode === null && parent.signalCode === null) {
                await once(parent, 'exit');
            }
            expect(isProcessAlive(parent.pid!)).toBe(false);
            expect(isProcessAlive(childPid)).toBe(true);

            await expect(killProcessByChildProcess(
                parent,
                false,
                rootStartMarker,
                Date.now() + 5_000,
                true,
                ownershipToken
            )).resolves.toBe(true);

            expect(isProcessAlive(childPid)).toBe(false);
        } finally {
            try {
                process.kill(-parent.pid!, 'SIGKILL');
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
            }
            if (parent.exitCode === null && parent.signalCode === null) {
                await once(parent, 'exit');
            }
        }
    });

    it('terminates a token-owned setsid child after its parent is reparented', async () => {
        const ownershipToken = `setsid-reparent-${process.pid}-${Date.now()}`;
        const parent = spawnChild(process.execPath, ['-e', [
            "const { spawn } = require('node:child_process')",
            "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })",
            'child.unref()',
            'console.log(child.pid)'
        ].join(';')], {
            detached: true,
            env: { ...process.env, [strictOwnershipEnv]: ownershipToken },
            stdio: ['ignore', 'pipe', 'ignore']
        });
        const rootStartMarker = requireProcessStartMarker(parent.pid!);
        let childPid: number | null = null;

        try {
            const output = await once(parent.stdout!, 'data');
            childPid = Number(output[0].toString().trim());
            if (parent.exitCode === null && parent.signalCode === null) {
                await once(parent, 'exit');
            }
            expect(isProcessAlive(parent.pid!)).toBe(false);
            expect(isProcessAlive(childPid)).toBe(true);

            await expect(killProcessByChildProcess(
                parent,
                false,
                rootStartMarker,
                Date.now() + 5_000,
                true,
                ownershipToken
            )).resolves.toBe(true);

            expect(isProcessAlive(childPid)).toBe(false);
        } finally {
            if (childPid !== null) {
                try {
                    process.kill(-childPid, 'SIGKILL');
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
                }
            }
            if (parent.exitCode === null && parent.signalCode === null) {
                await once(parent, 'exit');
            }
        }
    });

    it('terminates a detached helper spawned by the root SIGTERM handler', async () => {
        const ownershipToken = `signal-helper-${process.pid}-${Date.now()}`;
        const parent = spawnChild(process.execPath, ['-e', [
            "const { spawn } = require('node:child_process')",
            'let handling = false',
            "process.on('SIGTERM', () => {",
            'if (handling) return',
            'handling = true',
            "const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })",
            'helper.unref()',
            'console.log(helper.pid)',
            'setTimeout(() => process.exit(0), 50)',
            '})',
            "console.log('ready')",
            'setInterval(() => {}, 1000)'
        ].join(';')], {
            detached: true,
            env: { ...process.env, [strictOwnershipEnv]: ownershipToken },
            stdio: ['ignore', 'pipe', 'ignore']
        });
        const rootStartMarker = requireProcessStartMarker(parent.pid!);
        let helperPid: number | null = null;

        try {
            await once(parent.stdout!, 'data');
            const helperOutput = once(parent.stdout!, 'data');
            const termination = killProcessByChildProcess(
                parent,
                false,
                rootStartMarker,
                Date.now() + 5_000,
                true,
                ownershipToken
            );
            const output = await helperOutput;
            helperPid = Number(output[0].toString().trim());

            await expect(termination).resolves.toBe(true);
            expect(isProcessAlive(helperPid)).toBe(false);
        } finally {
            for (const processGroupId of [parent.pid!, helperPid]) {
                if (processGroupId === null) continue;
                try {
                    process.kill(-processGroupId, 'SIGKILL');
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
                }
            }
            if (parent.exitCode === null && parent.signalCode === null) {
                await once(parent, 'exit');
            }
        }
    });

    it('leaves a same-UID process with a different ownership token alive', async () => {
        const ownershipToken = `owned-${process.pid}-${Date.now()}`;
        const otherToken = `other-${process.pid}-${Date.now()}`;
        const owned = spawnChild(process.execPath, ['-e', [
            "process.stdout.write('ready')",
            'setInterval(() => {}, 1000)'
        ].join(';')], {
            detached: true,
            env: { ...process.env, [strictOwnershipEnv]: ownershipToken },
            stdio: ['ignore', 'pipe', 'ignore']
        });
        const other = spawnChild(process.execPath, ['-e', [
            "process.stdout.write('ready')",
            'setInterval(() => {}, 1000)'
        ].join(';')], {
            detached: true,
            env: { ...process.env, [strictOwnershipEnv]: otherToken },
            stdio: ['ignore', 'pipe', 'ignore']
        });
        const rootStartMarker = requireProcessStartMarker(owned.pid!);

        try {
            await Promise.all([once(owned.stdout!, 'data'), once(other.stdout!, 'data')]);

            await expect(killProcessByChildProcess(
                owned,
                false,
                rootStartMarker,
                Date.now() + 5_000,
                true,
                ownershipToken
            )).resolves.toBe(true);

            expect(isProcessAlive(owned.pid!)).toBe(false);
            expect(isProcessAlive(other.pid!)).toBe(true);
        } finally {
            for (const processGroupId of [owned.pid!, other.pid!]) {
                try {
                    process.kill(-processGroupId, 'SIGKILL');
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
                }
            }
            for (const child of [owned, other]) {
                if (child.exitCode === null && child.signalCode === null) {
                    await once(child, 'exit');
                }
            }
        }
    });

    it.skipIf(process.platform !== 'linux')(
        'fails closed for a newer nondumpable setsid helper after the root exits',
        async () => {
            const ownershipToken = `nondumpable-helper-${process.pid}-${Date.now()}`;
            const helperScript = [
                'import ctypes',
                'import time',
                'ctypes.CDLL(None).prctl(4, 0, 0, 0, 0)',
                "print('ready', flush=True)",
                'time.sleep(60)'
            ].join(';');
            const parent = spawnChild(process.execPath, ['-e', [
                "const { spawn } = require('node:child_process')",
                "console.log('ready')",
                "process.stdin.once('data', () => {",
                `const helper = spawn('python3', ['-c', ${JSON.stringify(helperScript)}], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })`,
                "helper.stdout.once('data', () => { console.log(helper.pid); helper.unref(); process.exit(0) })",
                '})',
                'process.stdin.resume()'
            ].join(';')], {
                detached: true,
                env: { ...process.env, [strictOwnershipEnv]: ownershipToken },
                stdio: ['pipe', 'pipe', 'ignore']
            });
            const rootStartMarker = requireProcessStartMarker(parent.pid!);
            let helperPid: number | null = null;

            try {
                await once(parent.stdout!, 'data');
                const helperOutput = once(parent.stdout!, 'data');
                parent.stdin!.write('spawn');
                const output = await helperOutput;
                helperPid = Number(output[0].toString().trim());
                if (parent.exitCode === null && parent.signalCode === null) {
                    await once(parent, 'exit');
                }
                expect(isProcessAlive(helperPid)).toBe(true);

                await expect(killProcessByChildProcess(
                    parent,
                    false,
                    rootStartMarker,
                    Date.now() + 5_000,
                    true,
                    ownershipToken
                )).resolves.toBe(false);

                expect(isProcessAlive(helperPid)).toBe(true);
            } finally {
                if (helperPid !== null) {
                    try {
                        process.kill(-helperPid, 'SIGKILL');
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
                    }
                }
                if (parent.exitCode === null && parent.signalCode === null) {
                    await once(parent, 'exit');
                }
            }
        }
    );

    it('fails without signaling the process group after its deadline', async () => {
        const ownershipToken = `expired-deadline-${process.pid}-${Date.now()}`;
        const parent = spawnChild(process.execPath, ['-e', [
            "process.stdout.write('ready')",
            'setInterval(() => {}, 1000)'
        ].join(';')], {
            detached: true,
            env: { ...process.env, [strictOwnershipEnv]: ownershipToken },
            stdio: ['ignore', 'pipe', 'ignore']
        });
        const rootStartMarker = requireProcessStartMarker(parent.pid!);

        try {
            await once(parent.stdout!, 'data');

            await expect(killProcessByChildProcess(
                parent,
                false,
                rootStartMarker,
                Date.now() - 1,
                true,
                ownershipToken
            )).resolves.toBe(false);
            expect(isProcessAlive(parent.pid!)).toBe(true);
        } finally {
            try {
                process.kill(-parent.pid!, 'SIGKILL');
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
            }
            if (parent.exitCode === null && parent.signalCode === null) {
                await once(parent, 'exit');
            }
        }
    });
});

describe('isProcessAlive', () => {
    it('returns false for ESRCH', () => {
        vi.spyOn(process, 'kill').mockImplementation((() => {
            throw Object.assign(new Error('missing'), { code: 'ESRCH' });
        }) as typeof process.kill);

        expect(isProcessAlive(123)).toBe(false);
    });

    it.each(['EPERM', 'EACCES', undefined])('returns false for %s probe failure', (code) => {
        vi.spyOn(process, 'kill').mockImplementation((() => {
            throw Object.assign(new Error('probe failed'), { code });
        }) as typeof process.kill);

        expect(isProcessAlive(123)).toBe(false);
    });
});
