import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Logger } from './logger'

describe('Logger.debugLargeJson', () => {
  const dirs: string[] = []
  const originalDebug = process.env.DEBUG

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalDebug === undefined) delete process.env.DEBUG
    else process.env.DEBUG = originalDebug
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('does not serialize inspected data without DEBUG and redacts credentials with DEBUG', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-logger-'))
    dirs.push(dir)
    const path = join(dir, 'debug.log')
    const logger = new Logger(path)
    delete process.env.DEBUG
    logger.debugLargeJson('environment', { token: 'top-secret', note: 'Bearer abcdefghijklmnop' })
    expect(readFileSync(path, 'utf8')).not.toContain('top-secret')
    expect(readFileSync(path, 'utf8')).not.toContain('abcdefghijklmnop')

    process.env.DEBUG = '1'
    logger.debugLargeJson('environment', {
      token: 'top-secret',
      note: 'Bearer abcdefghijklmnop',
      nested: 'OPENAI_API_KEY=sk-abcdefghijklmno'
    })
    const output = readFileSync(path, 'utf8')
    expect(output).not.toContain('top-secret')
    expect(output).not.toContain('abcdefghijklmnop')
    expect(output).not.toContain('sk-abcdefghijklmno')
    expect(output).toContain('[REDACTED]')
  })

  it('redacts credentials from ordinary structured log arguments', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-logger-'))
    dirs.push(dir)
    const path = join(dir, 'debug.log')
    const logger = new Logger(path)

    logger.debug('request failed CLAUDE_CODE_OAUTH_TOKEN=oauth-secret-value', {
      authorization: 'Bearer abcdefghijklmnop',
      nested: { OPENAI_API_KEY: 'sk-abcdefghijklmno' }
    })

    const output = readFileSync(path, 'utf8')
    expect(output).not.toContain('abcdefghijklmnop')
    expect(output).not.toContain('sk-abcdefghijklmno')
    expect(output).not.toContain('oauth-secret-value')
    expect(output).toContain('[REDACTED]')
  })

  it('redacts console output and does not expand Error cause or arbitrary data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-logger-'))
    dirs.push(dir)
    const logger = new Logger(join(dir, 'debug.log'))
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const error = Object.assign(new Error('failed Bearer console-secret'), {
      cause: { token: 'cause-secret' },
      data: { prompt: 'private-prompt' },
      method: 'turn/start',
      writeState: 'written'
    })

    logger.warn('OPENAI_API_KEY=sk-abcdefghijklmno', error)
    const serialized = JSON.stringify(spy.mock.calls)
    expect(serialized).not.toContain('console-secret')
    expect(serialized).not.toContain('cause-secret')
    expect(serialized).not.toContain('private-prompt')
    expect(serialized).not.toContain('sk-abcdefghijklmno')
    expect(serialized).toContain('[REDACTED')
    spy.mockRestore()
  })
})
