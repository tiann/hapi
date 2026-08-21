import { describe, expect, it } from 'vitest'
import { formatJobLine, parseJobArgs } from '@/commands/job'
import {
    SessionJobError,
    exitCodeForSessionJobError,
    resolveSessionByPrefix,
    resolveSessionIdForJobCli
} from '@/modules/sessionJob/sessionJob'

describe('parseJobArgs', () => {
    it('parses set with long flags', () => {
        const parsed = parseJobArgs([
            'set',
            'abcd1234',
            'beets',
            '--label',
            'beets import',
            '--remaining',
            '12',
            '--unit=tracks'
        ])
        expect(parsed.action).toBe('set')
        expect(parsed.sessionIdPrefix).toBe('abcd1234')
        expect(parsed.jobKey).toBe('beets')
        expect(parsed.label).toBe('beets import')
        expect(parsed.remaining).toBe(12)
        expect(parsed.unit).toBe('tracks')
    })

    it('parses run with command after --', () => {
        const parsed = parseJobArgs([
            'run',
            'sid',
            'drain',
            '--label=rsync',
            '--heartbeat-sec=60',
            '--',
            'bash',
            '-c',
            'echo hi'
        ])
        expect(parsed.action).toBe('run')
        expect(parsed.label).toBe('rsync')
        expect(parsed.heartbeatSec).toBe(60)
        expect(parsed.command).toEqual(['bash', '-c', 'echo hi'])
    })

    it('rejects bad status', () => {
        expect(() => parseJobArgs(['update', 's', 'k', '--status', 'nope'])).toThrow(SessionJobError)
    })

    it('parses --started-at for set', () => {
        const parsed = parseJobArgs([
            'set',
            'sid',
            'beets',
            '--label=beets',
            '--started-at=1785304595000'
        ])
        expect(parsed.startedAt).toBe(1_785_304_595_000)
    })

    it('rejects --started-at on update', () => {
        expect(() => parseJobArgs([
            'update',
            'sid',
            'beets',
            '--started-at=1785304595000'
        ])).toThrow(/--started-at is only valid with job set/)
    })

    it('rejects --heartbeat-sec on non-run actions', () => {
        expect(() => parseJobArgs([
            'set',
            'sid',
            'beets',
            '--label=beets',
            '--heartbeat-sec=300'
        ])).toThrow(/--heartbeat-sec is only valid with job run/)
        expect(() => parseJobArgs([
            'update',
            'sid',
            'beets',
            '--heartbeat-sec=60'
        ])).toThrow(/--heartbeat-sec is only valid with job run/)
    })

    it.each([
        ['list', ['list', 'sid', '--label=x'], /job list does not accept mutation flags/],
        ['clear+status', ['clear', 'sid', 'beets', '--status', 'completed'], /job clear only accepts --expected-run-id/],
        ['run+status', ['run', 'sid', 'beets', '--label=x', '--status', 'completed', '--', 'true'], /--status is not valid with job run/],
        ['clear+cmd', ['clear', 'sid', 'beets', '--', 'rm', '-rf', '/'], /-- <cmd> is only valid with job run/]
    ] as const)('rejects unsupported flags for %s', (_name, argv, pattern) => {
        expect(() => parseJobArgs([...argv])).toThrow(pattern)
    })

    it('parses --clear-remaining as null for update patches', () => {
        const parsed = parseJobArgs([
            'update',
            'sid',
            'beets',
            '--clear-remaining',
            '--done',
            '3',
            '--total',
            '10'
        ])
        expect(parsed.remaining).toBeNull()
        expect(parsed.done).toBe(3)
        expect(parsed.total).toBe(10)
    })

    it('parses --run-id on set and --expected-run-id on update/clear', () => {
        const setParsed = parseJobArgs([
            'set',
            'sid',
            'beets',
            '--label=beets',
            '--run-id=11111111-1111-1111-1111-111111111111'
        ])
        expect(setParsed.runId).toBe('11111111-1111-1111-1111-111111111111')

        const updateParsed = parseJobArgs([
            'update',
            'sid',
            'beets',
            '--remaining=9',
            '--expected-run-id=11111111-1111-1111-1111-111111111111'
        ])
        expect(updateParsed.expectedRunId).toBe('11111111-1111-1111-1111-111111111111')

        const clearParsed = parseJobArgs([
            'clear',
            'sid',
            'beets',
            '--expected-run-id=11111111-1111-1111-1111-111111111111'
        ])
        expect(clearParsed.expectedRunId).toBe('11111111-1111-1111-1111-111111111111')
    })

    it('rejects --run-id on update and --expected-run-id on set', () => {
        expect(() => parseJobArgs([
            'update',
            'sid',
            'beets',
            '--run-id=11111111-1111-1111-1111-111111111111'
        ])).toThrow(/--run-id is only valid with job set/)
        expect(() => parseJobArgs([
            'set',
            'sid',
            'beets',
            '--label=beets',
            '--expected-run-id=11111111-1111-1111-1111-111111111111'
        ])).toThrow(/--expected-run-id is only valid with job update or clear/)
    })
})

describe('resolveSessionByPrefix', () => {
    const sessions = [
        { id: 'aaaaaaaa-1111-1111-1111-111111111111' },
        { id: 'bbbbbbbb-2222-2222-2222-222222222222' },
        { id: 'bbbbcccc-3333-3333-3333-333333333333' }
    ]

    it('matches exact id', () => {
        expect(resolveSessionByPrefix(sessions, sessions[0]!.id).id).toBe(sessions[0]!.id)
    })

    it('matches unique prefix', () => {
        expect(resolveSessionByPrefix(sessions, 'aaaa').id).toBe(sessions[0]!.id)
    })

    it('errors on ambiguous prefix', () => {
        expect(() => resolveSessionByPrefix(sessions, 'bbbb')).toThrow(/matches 2 sessions/)
    })

    it('errors on no match', () => {
        expect(() => resolveSessionByPrefix(sessions, 'zzzz')).toThrow(/no session matching/)
    })
})

describe('resolveSessionIdForJobCli', () => {
    it('passes a full UUID through when missing from the session list', () => {
        const deleted = 'cccccccc-4444-4444-4444-444444444444'
        expect(resolveSessionIdForJobCli([], deleted)).toBe(deleted)
    })

    it('still errors for a non-uuid prefix with no list match', () => {
        expect(() => resolveSessionIdForJobCli([], 'deadbeef')).toThrow(/no session matching/)
    })
})

describe('exitCodeForSessionJobError', () => {
    it('maps codes', () => {
        expect(exitCodeForSessionJobError(new SessionJobError('bad_args', 'x'))).toBe(2)
        expect(exitCodeForSessionJobError(new SessionJobError('auth_failed', 'x'))).toBe(3)
        expect(exitCodeForSessionJobError(new SessionJobError('not_found', 'x'))).toBe(4)
        expect(exitCodeForSessionJobError(new SessionJobError('ambiguous', 'x'))).toBe(5)
        expect(exitCodeForSessionJobError(new SessionJobError('request_failed', 'x'))).toBe(1)
    })
})

describe('formatJobLine terminal sanitization', () => {
    it('strips ANSI/OSC and C0 controls from job text fields', () => {
        const line = formatJobLine({
            key: 'beets\u0007',
            label: '\u001b[31mimport\u001b[0m',
            status: 'running',
            unit: 'tracks\u001b]8;;http://evil\u0007',
            detail: 'phase\u001b]52;c;QUFB\u0007done\u009devil\u009c',
            runId: 'run-\u001b[1mid\u001b[0m',
            remaining: 3,
            heartbeatAt: Date.now() - 5_000,
            startedAt: Date.now() - 60_000
        }, { includeTiming: true })
        expect(line).not.toMatch(/\u001b/)
        expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
        expect(line).toContain('beets')
        expect(line).toContain('import')
        expect(line).toContain('3 tracks left')
        expect(line).toContain('phase')
        expect(line).toContain('done')
        expect(line).toContain('runId run-id')
        expect(line).not.toMatch(/http:\/\/evil/)
        expect(line).not.toMatch(/QUFB/)
    })
})
