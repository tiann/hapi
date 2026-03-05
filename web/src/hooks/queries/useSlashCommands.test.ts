import { describe, expect, it } from 'vitest'
import type { SlashCommand } from '@/types/api'
import { mergeSlashCommands, shouldAttemptSlashEntryRefetch } from './useSlashCommands'

describe('mergeSlashCommands', () => {
    it('keeps builtin commands and appends allowed remote sources', () => {
        const builtin: SlashCommand[] = [
            { name: 'status', source: 'builtin' },
            { name: 'clear', source: 'builtin' },
        ]
        const remote: SlashCommand[] = [
            { name: 'project-sync', source: 'project' },
            { name: 'plugin-action', source: 'plugin' },
            { name: 'user-template', source: 'user' },
        ]

        const merged = mergeSlashCommands(builtin, remote)

        expect(merged.map((item) => item.name)).toEqual([
            'status',
            'clear',
            'project-sync',
            'plugin-action',
            'user-template',
        ])
    })

    it('deduplicates command names case-insensitively', () => {
        const builtin: SlashCommand[] = [{ name: 'status', source: 'builtin' }]
        const remote: SlashCommand[] = [
            { name: 'STATUS', source: 'project' },
            { name: 'status', source: 'user' },
            { name: 'Status', source: 'plugin' },
            { name: 'fresh', source: 'project' },
        ]

        const merged = mergeSlashCommands(builtin, remote)

        expect(merged.map((item) => item.name)).toEqual(['status', 'fresh'])
    })

    it('ignores unsupported command sources', () => {
        const builtin: SlashCommand[] = [{ name: 'status', source: 'builtin' }]
        const remote = [
            { name: 'status-remote', source: 'builtin' },
            { name: 'fresh', source: 'project' },
        ] as SlashCommand[]

        const merged = mergeSlashCommands(builtin, remote)

        expect(merged.map((item) => item.name)).toEqual(['status', 'fresh'])
    })
})

describe('shouldAttemptSlashEntryRefetch', () => {
    it('returns true before first successful fetch', () => {
        const result = shouldAttemptSlashEntryRefetch(
            {
                hasFetchedSuccessfully: false,
                lastFetchError: null,
                lastEntryRefetchAt: 1000,
            },
            1500,
            4000
        )

        expect(result).toBe(true)
    })

    it('returns true when previous fetch failed', () => {
        const result = shouldAttemptSlashEntryRefetch(
            {
                hasFetchedSuccessfully: true,
                lastFetchError: 'network error',
                lastEntryRefetchAt: 1000,
            },
            1500,
            4000
        )

        expect(result).toBe(true)
    })

    it('returns false inside cooldown when last fetch succeeded', () => {
        const result = shouldAttemptSlashEntryRefetch(
            {
                hasFetchedSuccessfully: true,
                lastFetchError: null,
                lastEntryRefetchAt: 1000,
            },
            4500,
            4000
        )

        expect(result).toBe(false)
    })

    it('returns true after cooldown when last fetch succeeded', () => {
        const result = shouldAttemptSlashEntryRefetch(
            {
                hasFetchedSuccessfully: true,
                lastFetchError: null,
                lastEntryRefetchAt: 1000,
            },
            5001,
            4000
        )

        expect(result).toBe(true)
    })

    it('returns true exactly at cooldown boundary', () => {
        const result = shouldAttemptSlashEntryRefetch(
            {
                hasFetchedSuccessfully: true,
                lastFetchError: null,
                lastEntryRefetchAt: 1000,
            },
            5000,
            4000
        )

        expect(result).toBe(true)
    })
})
