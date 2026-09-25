import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SESSION_HEADER_METADATA, parseSessionHeaderMetadata } from './useSessionHeaderMetadata'

describe('parseSessionHeaderMetadata', () => {
    beforeEach(() => localStorage.clear())

    it('preserves the existing header display by default', () => {
        expect(parseSessionHeaderMetadata(null)).toEqual(DEFAULT_SESSION_HEADER_METADATA)
        expect(DEFAULT_SESSION_HEADER_METADATA).toMatchObject({
            showLabels: true,
            agent: true,
            agentIcon: true,
            model: true,
            reasoning: true,
            fastMode: true,
            machine: true,
            lastActive: true,
            createdAt: false,
            updatedAt: false,
            worktree: true,
        })
    })

    it('merges stored booleans with defaults for forward compatibility', () => {
        expect(parseSessionHeaderMetadata(JSON.stringify({ showLabels: false, agentIcon: false, reasoning: false, createdAt: true, model: 'nope' }))).toEqual({
            ...DEFAULT_SESSION_HEADER_METADATA,
            showLabels: false,
            agentIcon: false,
            reasoning: false,
            createdAt: true,
        })
    })

    it('migrates the previous Agent visibility choice to the icon preference', () => {
        expect(parseSessionHeaderMetadata(JSON.stringify({ agent: false }))).toMatchObject({
            agent: false,
            agentIcon: false,
        })
        expect(parseSessionHeaderMetadata(JSON.stringify({ agent: true }))).toMatchObject({
            agent: true,
            agentIcon: true,
        })
    })

    it('ignores invalid stored values', () => {
        expect(parseSessionHeaderMetadata('{')).toEqual(DEFAULT_SESSION_HEADER_METADATA)
        expect(parseSessionHeaderMetadata('[]')).toEqual(DEFAULT_SESSION_HEADER_METADATA)
    })
})
