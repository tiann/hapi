import { existsSync, mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { configuration } from '@/configuration'
import { hashObject } from '@/utils/deterministicJson'
import { recordCatalog } from './catalogCache'

vi.mock('@/configuration', async original => {
    const actual = await original<typeof import('@/configuration')>()
    return { ...actual, configuration: { ...actual.configuration, get happyHomeDir() { return actual.configuration.happyHomeDir } } }
})

it('prunes expired stamps for sessions that never reopen', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'claude-catalog-prune-'))
    vi.spyOn(configuration, 'happyHomeDir', 'get').mockReturnValue(cwd)
    try {
        const lists = { tools: ['Read'], slashCommands: ['help'] }
        recordCatalog('old', { cwd }, lists, '2.1.0', [])
        const dir = join(cwd, 'claude-catalog')
        const old = join(dir, hashObject('old') + '.json')
        const expired = new Date(Date.now() - 25 * 60 * 60 * 1000)
        utimesSync(old, expired, expired)
        utimesSync(join(dir, '.last-prune'), expired, expired)
        recordCatalog('fresh', { cwd }, lists, '2.1.0', [])
        expect(existsSync(old)).toBe(false)
        expect(existsSync(join(dir, hashObject('fresh') + '.json'))).toBe(true)
    } finally {
        vi.restoreAllMocks()
        rmSync(cwd, { recursive: true, force: true })
    }
})
