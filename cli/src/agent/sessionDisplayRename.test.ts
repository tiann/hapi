import { describe, expect, it, vi } from 'vitest'
import { applySessionDisplayRename, normalizeSessionDisplayTitle } from './sessionDisplayRename'
import type { Metadata } from '@/api/types'

describe('sessionDisplayRename', () => {
    it('normalizes whitespace and rejects empty titles', () => {
        expect(normalizeSessionDisplayTitle('  Fix login   bug  ')).toBe('Fix login bug')
        expect(normalizeSessionDisplayTitle('')).toBeNull()
        expect(normalizeSessionDisplayTitle('   ')).toBeNull()
        expect(normalizeSessionDisplayTitle(null)).toBeNull()
    })

    it('sets metadata.name even when a spawn name already exists', () => {
        let metadata: Metadata = {
            path: '/tmp/project',
            host: 'localhost',
            name: 'issue-triage-#54',
            summary: { text: 'Old summary', updatedAt: 1 }
        }
        const client = {
            updateMetadata: vi.fn((handler: (current: Metadata) => Metadata) => {
                metadata = handler(metadata)
            })
        }

        expect(applySessionDisplayRename(client, '  Renamed triage peer  ')).toBe(true)
        expect(metadata.name).toBe('Renamed triage peer')
        expect(metadata.summary?.text).toBe('Old summary')
        expect(client.updateMetadata).toHaveBeenCalledTimes(1)
    })

    it('sets metadata.name when only a summary exists', () => {
        let metadata: Metadata = {
            path: '/tmp/project',
            host: 'localhost',
            summary: { text: 'Generated summary', updatedAt: 1 }
        }
        const client = {
            updateMetadata: vi.fn((handler: (current: Metadata) => Metadata) => {
                metadata = handler(metadata)
            })
        }

        expect(applySessionDisplayRename(client, 'Explicit rename')).toBe(true)
        expect(metadata.name).toBe('Explicit rename')
        expect(metadata.summary?.text).toBe('Generated summary')
    })

    it('returns false without writing when the title is empty', () => {
        const client = { updateMetadata: vi.fn() }
        expect(applySessionDisplayRename(client, '   ')).toBe(false)
        expect(client.updateMetadata).not.toHaveBeenCalled()
    })
})
