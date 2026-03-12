import { describe, expect, it } from 'vitest'
import type { Machine, SessionSummary } from '@/types/api'
import { getMachineLabel, groupSessionsByDirectory } from './sessionListUtils'

function createSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
    return {
        id: overrides.id ?? 'session-1',
        updatedAt: overrides.updatedAt ?? 1,
        activeAt: overrides.activeAt ?? 1,
        active: overrides.active ?? false,
        pendingRequestsCount: overrides.pendingRequestsCount ?? 0,
        thinking: overrides.thinking ?? false,
        modelMode: overrides.modelMode ?? undefined,
        todoProgress: overrides.todoProgress ?? null,
        metadata: {
            path: '/root/project-a',
            machineId: 'machine-alpha-1234',
            ...overrides.metadata,
        },
    }
}

describe('SessionList helpers', () => {
    it('separates groups by machine when directory is the same', () => {
        const machinesById = new Map<string, Machine>([
            ['machine-alpha-1234', { id: 'machine-alpha-1234', active: true, metadata: { host: 'alpha-host', platform: 'linux', happyCliVersion: '0.16.1' } }],
            ['machine-beta-5678', { id: 'machine-beta-5678', active: true, metadata: { host: 'beta-host', platform: 'linux', happyCliVersion: '0.16.1' } }],
        ])
        const sessions = [
            createSession({
                id: 'a',
                metadata: {
                    path: '/root/project-a',
                    machineId: 'machine-alpha-1234',
                },
            }),
            createSession({
                id: 'b',
                metadata: {
                    path: '/root/project-a',
                    machineId: 'machine-beta-5678',
                },
            }),
        ]

        const groups = groupSessionsByDirectory(sessions, machinesById)

        expect(groups).toHaveLength(2)
        expect(groups.map(group => group.machineLabel)).toEqual(['alpha-host', 'beta-host'])
    })

    it('falls back to a short machine id when host is unavailable', () => {
        const label = getMachineLabel(
            'de5b5751-112d-42d4-b330-5b8ec3822cea',
            new Map()
        )

        expect(label).toBe('de5b5751')
    })
})
