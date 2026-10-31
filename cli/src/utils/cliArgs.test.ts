import { basename } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeCliArgs } from './cliArgs'

describe('CLI argv normalization', () => {
    const exec = process.execPath
    const entrypoint = '/workspace/cli/src/index.ts'

    afterEach(() => { vi.unstubAllGlobals() })

    it.each([
        [exec],
        [basename(exec)],
        [exec, entrypoint],
        ['bun', entrypoint],
        [exec, entrypoint, '--']
    ])('strips the runtime wrapper %j without consuming command arguments', (...prefix) => {
        const args = ['codex', '--', '--help', '--version', 'prompt with spaces']
        expect(normalizeCliArgs([...prefix, ...args])).toEqual(args)
    })

    it('preserves a separator in already normalized arguments', () => {
        expect(normalizeCliArgs(['claude', '--', '--model', 'literal']))
            .toEqual(['claude', '--', '--model', 'literal'])
        expect(normalizeCliArgs(['--', '--help'])).toEqual(['--', '--help'])
    })

    it('preserves runner handoff arguments for compiled and source entrypoints', () => {
        const args = ['runner', 'start-sync', '--workspace-root', '/my project']
        expect(normalizeCliArgs([exec, ...args])).toEqual(args)
        expect(normalizeCliArgs([exec, entrypoint, ...args])).toEqual(args)
    })

    it('returns an empty command for bare invocations', () => {
        expect(normalizeCliArgs([])).toEqual([])
        expect(normalizeCliArgs([exec])).toEqual([])
        expect(normalizeCliArgs([exec, entrypoint])).toEqual([])
    })

    it('preserves filenames used as prompts instead of treating them as entrypoints', () => {
        vi.stubGlobal('Bun', { main: entrypoint })
        expect(normalizeCliArgs([exec, entrypoint, 'prompt.ts', 'another.js']))
            .toEqual(['prompt.ts', 'another.js'])
        expect(normalizeCliArgs(['prompt.ts'])).toEqual(['prompt.ts'])
    })

    it('handles Bun virtual entrypoints and compiled process argv', () => {
        const main = '/$bunfs/root/hapi'
        vi.stubGlobal('Bun', { main })
        expect(normalizeCliArgs(['bun', main, 'codex', '--', '--help']))
            .toEqual(['codex', '--', '--help'])
        expect(normalizeCliArgs(['bun', main, 'prompt.ts'])).toEqual(['prompt.ts'])
        expect(normalizeCliArgs([exec, 'prompt.ts'])).toEqual(['prompt.ts'])
        expect(normalizeCliArgs(['bun', main])).toEqual([])
    })
})
