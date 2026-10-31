import { describe, expect, it } from 'vitest'
import { DEFAULT_SESSION_HEADER_METADATA } from '@/hooks/useSessionHeaderMetadata'
import { getShareTurnReasoningLabel, selectShareTurnMetadata } from './shareTurnMetadata'

describe('selectShareTurnMetadata', () => {
    const available = {
        agent: { text: 'codex', flavor: 'codex' },
        project: { text: 'Project: coding/hapi' },
        machine: { text: 'Machine: workstation' },
        lastActive: { text: '2 minutes ago' },
        model: { text: 'Model: gpt-5.6-sol' },
        reasoning: { text: 'Reasoning: high' },
        fastMode: { text: 'fast' },
        createdAt: { text: 'Created: Aug 2, 2026, 10:00' },
        updatedAt: { text: 'Updated: Aug 2, 2026, 10:30' },
        worktree: { text: 'Worktree: feat/example' },
    }

    it('uses the desktop session-header order and default visibility', () => {
        expect(selectShareTurnMetadata(DEFAULT_SESSION_HEADER_METADATA, available).map((item) => item.key)).toEqual([
            'agent', 'project', 'machine', 'lastActive', 'model', 'reasoning', 'fastMode', 'worktree',
        ])
    })

    it('honors configured visibility and omits unavailable values', () => {
        const preferences = Object.fromEntries(
            Object.keys(DEFAULT_SESSION_HEADER_METADATA).map((key) => [key, false])
        ) as typeof DEFAULT_SESSION_HEADER_METADATA
        preferences.showLabels = true
        preferences.createdAt = true
        preferences.updatedAt = true
        preferences.machine = true

        expect(selectShareTurnMetadata(preferences, {
            ...available,
            machine: undefined,
        }).map((item) => item.key)).toEqual(['createdAt', 'updatedAt'])
    })

    it('uses Pi effort for shared reasoning metadata', () => {
        expect(getShareTurnReasoningLabel('pi', null, 'max', true)).toBe('reasoning max')
        expect(getShareTurnReasoningLabel('pi', null, 'max', false)).toBe('max')
    })
})
