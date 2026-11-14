import { describe, expect, it } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_PR_CHIP_DISPLAY } from '@hapi/protocol'
import { loadPrChipDisplayProfile } from './prChipDisplay'

describe('loadPrChipDisplayProfile', () => {
    it('returns generic defaults when the estate file is absent', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-pr-chip-'))
        expect(loadPrChipDisplayProfile(dir)).toEqual(DEFAULT_PR_CHIP_DISPLAY)
    })

    it('merges estateCodes over defaults', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-pr-chip-'))
        writeFileSync(join(dir, 'pr-chip-display.json'), JSON.stringify({
            estateCodes: {
                'babysit.green': {
                    emoji: '✅',
                    tone: 'ok',
                    label: 'clean',
                    action: 'full green — wait on tiann'
                }
            }
        }))
        const profile = loadPrChipDisplayProfile(dir)
        expect(profile.forge['merge.clean+checks.pass']?.label).toBe('ready to merge')
        expect(profile.estateCodes['babysit.green']?.action).toContain('tiann')
    })

    it('falls back to defaults on invalid JSON', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-pr-chip-'))
        writeFileSync(join(dir, 'pr-chip-display.json'), '{not-json')
        expect(loadPrChipDisplayProfile(dir)).toEqual(DEFAULT_PR_CHIP_DISPLAY)
    })
})
