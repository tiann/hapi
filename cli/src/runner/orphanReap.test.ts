import { describe, expect, it } from 'vitest'
import {
    commandMatchesRunnerSpawnedSession,
    reapRunnerSpawnedOrphans,
    selectOrphanPidsForSession,
} from './orphanReap'

describe('orphanReap argv matching', () => {
    const sessionId = 'sess-abc-123'

    it('matches runner-spawned CLI with --existing-session-id', () => {
        const cmd = `bun src/index.ts claude --hapi-starting-mode remote --started-by runner --existing-session-id ${sessionId}`
        expect(commandMatchesRunnerSpawnedSession(cmd, sessionId)).toBe(true)
    })

    it('matches --hapi-session-id= form', () => {
        const cmd = `hapi cursor --started-by=runner --hapi-session-id=${sessionId}`
        expect(commandMatchesRunnerSpawnedSession(cmd, sessionId)).toBe(true)
    })

    it('rejects terminal-started sessions', () => {
        const cmd = `bun src/index.ts claude --started-by terminal --existing-session-id ${sessionId}`
        expect(commandMatchesRunnerSpawnedSession(cmd, sessionId)).toBe(false)
    })

    it('rejects --resume native id that merely equals the session string', () => {
        // Guard: native agent resume ids must not be treated as HAPI row ids.
        const cmd = `bun src/index.ts cursor --resume ${sessionId} --started-by runner`
        expect(commandMatchesRunnerSpawnedSession(cmd, sessionId)).toBe(false)
    })

    it('rejects substring false positives', () => {
        const cmd = `bun src/index.ts claude --started-by runner --existing-session-id ${sessionId}-extra`
        expect(commandMatchesRunnerSpawnedSession(cmd, sessionId)).toBe(false)
    })

    it('selectOrphanPidsForSession filters non-hapi and self', () => {
        const pids = selectOrphanPidsForSession(
            [
                { pid: 1, cmd: 'systemd', name: 'systemd' },
                { pid: 42, cmd: `bun src/index.ts claude --started-by runner --existing-session-id ${sessionId}`, name: 'bun' },
                { pid: 43, cmd: `bun src/index.ts claude --started-by runner --existing-session-id other`, name: 'bun' },
                { pid: process.pid, cmd: `bun src/index.ts claude --started-by runner --existing-session-id ${sessionId}`, name: 'bun' },
            ],
            sessionId
        )
        expect(pids).toEqual([42])
    })

    it('selectOrphanPidsForSession coerces string PIDs from win32 ps-list', () => {
        const pids = selectOrphanPidsForSession(
            [
                {
                    // ps-list has returned string PIDs on Windows; Number.isFinite("42") is false
                    pid: '42' as unknown as number,
                    cmd: `hapi.exe cursor --started-by runner --existing-session-id ${sessionId}`,
                    name: 'hapi.exe',
                },
            ],
            sessionId
        )
        expect(pids).toEqual([42])
    })

    it('matches win32 CIM snapshots that include CommandLine', () => {
        const pids = selectOrphanPidsForSession(
            [
                {
                    pid: 99,
                    name: 'hapi.exe',
                    cmd: `"C:\\\\Temp\\\\hapi.exe" /c keep.cmd --started-by runner --existing-session-id ${sessionId}`,
                },
                {
                    pid: 100,
                    name: 'hapi.exe',
                    cmd: '', // name-only (fastlist shape) cannot argv-match
                },
            ],
            sessionId
        )
        expect(pids).toEqual([99])
    })
})

describe('reapRunnerSpawnedOrphans (stopSession orphan path)', () => {
    const stableMarker = (marker = 'gen-a') => {
        let reads = 0
        return () => {
            reads++
            // Capture + re-check both return the same generation.
            void reads
            return marker
        }
    }

    it('returns null when no argv orphans match', async () => {
        const status = await reapRunnerSpawnedOrphans('missing-session', {
            findOrphans: async () => [],
            killTree: async () => {
                throw new Error('should not kill')
            },
            getStartMarker: () => 'unused',
        })
        expect(status).toBeNull()
    })

    it('kills matching orphan PIDs and returns stopped when maps would have missed', async () => {
        const killed: number[] = []
        const status = await reapRunnerSpawnedOrphans('sess-orphan-1', {
            findOrphans: async (sessionId) => {
                expect(sessionId).toBe('sess-orphan-1')
                return [4242, 4243]
            },
            killTree: async (pid) => {
                killed.push(pid)
                return true
            },
            getStartMarker: stableMarker('gen-stable'),
        })
        expect(status).toBe('stopped')
        expect(killed).toEqual([4242, 4243])
    })

    it('returns still_alive when the process scan fails', async () => {
        const status = await reapRunnerSpawnedOrphans('sess-orphan-scan-fail', {
            findOrphans: async () => 'scan_failed',
            killTree: async () => {
                throw new Error('should not kill')
            },
        })
        expect(status).toBe('still_alive')
    })

    it('returns still_alive when tree-kill cannot prove death', async () => {
        const status = await reapRunnerSpawnedOrphans('sess-orphan-2', {
            findOrphans: async () => [9999],
            killTree: async () => false,
            getStartMarker: stableMarker(),
        })
        expect(status).toBe('still_alive')
    })

    it('does not kill when start marker changes between capture and kill (PID reuse)', async () => {
        const killed: number[] = []
        const markers = new Map<number, string[]>([
            // First read = capture after argv match; second = pre-kill re-check
            [4242, ['gen-orphan', 'gen-reused-unrelated']],
        ])
        const status = await reapRunnerSpawnedOrphans('sess-orphan-reuse', {
            findOrphans: async () => [4242],
            killTree: async (pid) => {
                killed.push(pid)
                return true
            },
            getStartMarker: (pid) => {
                const queue = markers.get(pid)
                if (!queue || queue.length === 0) return null
                return queue.shift() ?? null
            },
            isAlive: () => true,
        })
        expect(killed).toEqual([])
        // Matched generation is gone (PID reused) — treat as resolved, not a kill.
        expect(status).toBe('stopped')
    })

    it('returns still_alive when pre-kill marker probe fails while PID is alive', async () => {
        const killed: number[] = []
        const markers = new Map<number, Array<string | null>>([
            [4242, ['gen-orphan', null]],
        ])
        const status = await reapRunnerSpawnedOrphans('sess-orphan-probe-fail', {
            findOrphans: async () => [4242],
            killTree: async (pid) => {
                killed.push(pid)
                return true
            },
            getStartMarker: (pid) => {
                const queue = markers.get(pid)
                if (!queue || queue.length === 0) return null
                return queue.shift() ?? null
            },
            isAlive: () => true,
        })
        expect(killed).toEqual([])
        // Null re-check is not proof of death — must not claim stopped.
        expect(status).toBe('still_alive')
    })

    it('returns still_alive without killing when marker cannot be read for a live orphan', async () => {
        const killed: number[] = []
        const status = await reapRunnerSpawnedOrphans('sess-orphan-no-marker', {
            findOrphans: async () => [5555],
            killTree: async (pid) => {
                killed.push(pid)
                return true
            },
            getStartMarker: () => null,
            isAlive: () => true,
        })
        expect(killed).toEqual([])
        expect(status).toBe('still_alive')
    })

    it('uses same-snapshot startMarker as expected (not a later probe) for PID-reuse guard', async () => {
        const killed: number[] = []
        const status = await reapRunnerSpawnedOrphans('sess-orphan-snapshot', {
            findTargets: async () => [
                { pid: 4242, startMarker: 'snapshot-gen' },
            ],
            killTree: async (pid) => {
                killed.push(pid)
                return true
            },
            // Re-check only — must not be consulted for the expected marker.
            getStartMarker: () => 'snapshot-gen',
            isAlive: () => true,
        })
        expect(status).toBe('stopped')
        expect(killed).toEqual([4242])
    })

    it('continues other orphans when one live PID has an unreadable marker', async () => {
        const killed: number[] = []
        const status = await reapRunnerSpawnedOrphans('sess-orphan-partial', {
            findTargets: async () => [
                { pid: 1111, startMarker: null },
                { pid: 2222, startMarker: 'gen-ok' },
            ],
            killTree: async (pid) => {
                killed.push(pid)
                return true
            },
            getStartMarker: (pid) => (pid === 2222 ? 'gen-ok' : null),
            isAlive: () => true,
        })
        expect(killed).toEqual([2222])
        expect(status).toBe('still_alive')
    })

    it('PID-filter on findTargets retains same-snapshot markers (runner stopSession shape)', async () => {
        // Regression: run.ts used findOrphans → number[], which forced a later
        // getStartMarker probe and discarded the argv-snapshot marker (#1911 bot).
        const killed: number[] = []
        const protectedPids = new Set([1111])
        const status = await reapRunnerSpawnedOrphans('sess-orphan-filter', {
            findTargets: async () => {
                const found = [
                    { pid: 1111, startMarker: 'snap-protected' },
                    { pid: 2222, startMarker: 'snap-orphan' },
                ]
                return found.filter((t) => !protectedPids.has(t.pid))
            },
            killTree: async (pid) => {
                killed.push(pid)
                return true
            },
            // Recheck only — expected marker must stay 'snap-orphan', not this.
            getStartMarker: () => 'snap-orphan',
            isAlive: () => true,
        })
        expect(killed).toEqual([2222])
        expect(status).toBe('stopped')
    })
})

describe('Windows orphan startMarker format agreement', () => {
    it('list + single-probe CIM commands stringify CreationDate the same way', async () => {
        const { WINDOWS_CIM_CREATION_DATE_MARKER_EXPR, windowsProcessListCimCommand, windowsProcessMarkerCimCommand } =
            await import('./orphanReap')
        expect(WINDOWS_CIM_CREATION_DATE_MARKER_EXPR).toContain("ToString('o')")
        expect(windowsProcessListCimCommand()).toContain(WINDOWS_CIM_CREATION_DATE_MARKER_EXPR)
        const probe = windowsProcessMarkerCimCommand(4242)
        expect(probe).toContain("CreationDate.ToUniversalTime().ToString('o')")
        expect(probe).toContain('ProcessId = 4242')
        // Must not feed raw DateTime into ConvertTo-Json (WinPS emits /Date(...)/).
        expect(windowsProcessListCimCommand()).toMatch(/CreationDate.*ToString\('o'\)/)
    })
})
