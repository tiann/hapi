import { describe, expect, it } from 'vitest'
import { normalizeCliArgs } from './cliArgs'

describe('normalizeCliArgs (tiann/hapi#1404 job run --)', () => {
    it('keeps job run flags and the -- child separator under bun entrypoint', () => {
        const normalized = normalizeCliArgs([
            'bun',
            'src/index.ts',
            'job',
            'run',
            'SID',
            'KEY',
            '--label',
            'x',
            '--',
            '/bin/echo',
            'hi'
        ])
        expect(normalized).toEqual([
            'job',
            'run',
            'SID',
            'KEY',
            '--label',
            'x',
            '--',
            '/bin/echo',
            'hi'
        ])
    })

    it('keeps -- for an installed binary argv (no runtime-wrapper handoff)', () => {
        const hapiBin = process.execPath
        const normalized = normalizeCliArgs([
            hapiBin,
            'job',
            'run',
            'SID',
            'KEY',
            '--label',
            'x',
            '--',
            '/bin/echo',
            'hi'
        ])
        expect(normalized).toEqual([
            'job',
            'run',
            'SID',
            'KEY',
            '--label',
            'x',
            '--',
            '/bin/echo',
            'hi'
        ])
    })

    it('still treats bun entrypoint -- as runtime handoff when no HAPI command precedes it', () => {
        expect(normalizeCliArgs([
            'bun',
            'src/index.ts',
            '--',
            'auth',
            'login'
        ])).toEqual(['auth', 'login'])
    })

    it('does not re-insert -- for hapi -- auth login', () => {
        const hapiBin = process.execPath
        expect(normalizeCliArgs([
            hapiBin,
            '--',
            'auth',
            'login'
        ])).toEqual(['auth', 'login'])
    })

    it('does not re-insert -- for hapi codex -- --model o3', () => {
        const hapiBin = process.execPath
        expect(normalizeCliArgs([
            hapiBin,
            'codex',
            '--',
            '--model',
            'o3'
        ])).toEqual(['codex', '--model', 'o3'])
    })
})
