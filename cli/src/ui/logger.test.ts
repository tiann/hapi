import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpDirs: string[] = []

function freshLogPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-logger-test-'))
    tmpDirs.push(dir)
    return join(dir, 'test.log')
}

afterEach(() => {
    while (tmpDirs.length) {
        const dir = tmpDirs.pop()!
        try {
            rmSync(dir, { recursive: true, force: true })
        } catch {
            // best effort
        }
    }
})

describe('logger Error serialization', () => {
    it('logs an Error argument with its message and stack, not "{}"', async () => {
        const { Logger } = await import('./logger')
        const logPath = freshLogPath()
        const logger = new Logger(logPath)

        const error = new Error('Session 6f0c4551 is currently running as a background agent (bg).')
        logger.debug('[remote]: launch error', error)

        const contents = readFileSync(logPath, 'utf8')
        expect(contents).toContain('is currently running as a background agent')
        expect(contents).toContain('"name"')
        expect(contents).toContain('"stack"')
        // The whole point: the old `JSON.stringify(error)` collapsed to "{}".
        expect(contents).not.toContain('[remote]: launch error {}')
    })

    it('surfaces Errors nested inside objects via debugLargeJson', async () => {
        const prevDebug = process.env.DEBUG
        process.env.DEBUG = '1'
        try {
            const { Logger } = await import('./logger')
            const logPath = freshLogPath()
            const logger = new Logger(logPath)

            logger.debugLargeJson('[remote]: payload', {
                cause: new Error('boom failure detail')
            })

            const contents = readFileSync(logPath, 'utf8')
            expect(contents).toContain('boom failure detail')
            expect(contents).toContain('"message"')
        } finally {
            if (prevDebug === undefined) {
                delete process.env.DEBUG
            } else {
                process.env.DEBUG = prevDebug
            }
        }
    })
})
