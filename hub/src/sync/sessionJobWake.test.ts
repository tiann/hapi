import { describe, expect, it } from 'bun:test'
import {
    buildJobTerminalWakePrompt,
    isTerminalJobStatus,
    waitUntilSessionActive,
} from './sessionJobWake'

describe('sessionJobWake (#1489)', () => {
    it('classifies terminal statuses only', () => {
        expect(isTerminalJobStatus('running')).toBe(false)
        expect(isTerminalJobStatus('completed')).toBe(true)
        expect(isTerminalJobStatus('failed')).toBe(true)
    })

    it('builds wake prompt with key, status, detail, and prescription', () => {
        const text = buildJobTerminalWakePrompt({
            key: 'beets',
            label: 'beets import',
            status: 'completed',
            detail: 'album: Daft Punk',
            runId: 'run-1',
            wakePrompt: 'Start the next album batch.',
        })
        expect(text).toContain('job "beets"')
        expect(text).toContain('status=completed')
        expect(text).toContain('Detail: album: Daft Punk')
        expect(text).toContain('runId: run-1')
        expect(text).toContain('Start the next album batch.')
    })

    it('omits empty prescription and uses (none) for missing detail', () => {
        const text = buildJobTerminalWakePrompt({
            key: 'drain',
            label: 'music drain',
            status: 'failed',
        })
        expect(text).toContain('Detail: (none)')
        expect(text).not.toContain('Prescription:')
    })

    it('waitUntilSessionActive resolves when getActive flips true', async () => {
        let n = 0
        const ok = await waitUntilSessionActive({
            getActive: () => {
                n += 1
                return n >= 3
            },
            sleep: async () => undefined,
            now: (() => {
                let t = 0
                return () => {
                    t += 1
                    return t
                }
            })(),
            timeoutMs: 100,
            pollMs: 1,
        })
        expect(ok).toBe(true)
        expect(n).toBeGreaterThanOrEqual(3)
    })

    it('waitUntilSessionActive returns false on timeout', async () => {
        const ok = await waitUntilSessionActive({
            getActive: () => false,
            sleep: async () => undefined,
            now: (() => {
                let t = 0
                return () => {
                    const cur = t
                    t += 50
                    return cur
                }
            })(),
            timeoutMs: 100,
            pollMs: 1,
        })
        expect(ok).toBe(false)
    })
})
