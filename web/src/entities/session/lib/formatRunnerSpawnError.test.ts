import { describe, expect, it } from 'vitest'
import { formatRunnerSpawnError } from './formatRunnerSpawnError'

describe('formatRunnerSpawnError lib', () => {
    describe('formatRunnerSpawnError', () => {
        it('returns null when machine is null', () => {
            expect(formatRunnerSpawnError(null)).toBe(null)
        })

        it('returns null when runnerState is null', () => {
            const machine = { runnerState: null }
            expect(formatRunnerSpawnError(machine)).toBe(null)
        })

        it('returns null when lastSpawnError is undefined', () => {
            const machine = { runnerState: {} }
            expect(formatRunnerSpawnError(machine)).toBe(null)
        })

        it('returns null when message is empty', () => {
            const machine = {
                runnerState: {
                    lastSpawnError: { message: '', at: Date.now() },
                },
            }
            expect(formatRunnerSpawnError(machine)).toBe(null)
        })

        it('returns message without timestamp when at is missing', () => {
            const machine = {
                runnerState: {
                    lastSpawnError: { message: 'Spawn failed', at: 0 },
                },
            }
            expect(formatRunnerSpawnError(machine)).toContain('Spawn failed')
        })

        it('returns message with formatted timestamp', () => {
            const timestamp = new Date('2024-01-15T10:30:00').getTime()
            const machine = {
                runnerState: {
                    lastSpawnError: { message: 'Spawn failed', at: timestamp },
                },
            }
            const result = formatRunnerSpawnError(machine)
            expect(result).toContain('Spawn failed')
            expect(result).toContain('(')
            expect(result).toContain(')')
        })

        it('handles error with pid and exitCode', () => {
            const machine = {
                runnerState: {
                    lastSpawnError: {
                        message: 'Process exited',
                        pid: 1234,
                        exitCode: 1,
                        at: Date.now(),
                    },
                },
            }
            const result = formatRunnerSpawnError(machine)
            expect(result).toContain('Process exited')
        })

        it('handles error with signal', () => {
            const machine = {
                runnerState: {
                    lastSpawnError: {
                        message: 'Process killed',
                        signal: 'SIGTERM',
                        at: Date.now(),
                    },
                },
            }
            const result = formatRunnerSpawnError(machine)
            expect(result).toContain('Process killed')
        })
    })
})
