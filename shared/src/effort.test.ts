import { describe, expect, test } from 'bun:test'
import { CLAUDE_EFFORT_LABELS, CLAUDE_EFFORT_LEVELS } from './effort'

describe('Claude effort constants', () => {
    test('exposes the Claude Code --effort levels in ascending order', () => {
        expect(CLAUDE_EFFORT_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    })

    test('every CLAUDE_EFFORT_LEVEL has a label', () => {
        for (const level of CLAUDE_EFFORT_LEVELS) {
            expect(CLAUDE_EFFORT_LABELS[level]).toBeDefined()
        }
    })
})
