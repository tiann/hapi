import { describe, expect, it } from 'vitest'
import type { ResumableSession } from '@hapi/protocol'
import {
    filterResumeSessions,
    formatResumeSessionRelativeTime,
    getResumeSessionName,
    reducePickerState,
    type PickerState
} from './resumeSessionPickerState'

function session(overrides: Partial<ResumableSession>): ResumableSession {
    return {
        sessionId: 'session-1',
        flavor: 'codex',
        directory: '/tmp/project',
        machineId: 'machine-1',
        active: false,
        thinking: false,
        controlledByUser: false,
        agentSessionId: 'agent-1',
        updatedAt: 1,
        ...overrides
    }
}

describe('resumeSessionPickerState', () => {
    it.each([
        [{ name: 'Saved title', summary: 'Summary', promptTitle: 'Prompt title' }, 'Saved title'],
        [{ summary: 'Summary', promptTitle: 'Prompt title' }, 'Summary'],
        [{ promptTitle: 'Prompt title' }, 'Prompt title'],
        [{ directory: '/work/project' }, 'project'],
        [{ directory: 'C:\\Users\\jader\\project\\' }, 'project'],
        [{ directory: '\\\\server\\share\\project' }, 'project'],
        [{ directory: 'C:\\' }, 'session-'],
        [{ directory: '/work/a\\b' }, 'a\\b'],
        [{ directory: '/' }, 'session-']
    ] as const)('uses the web title rules with %j', (overrides, title) => {
        expect(getResumeSessionName(session({
            flavor: 'claude',
            firstUserMessage: 'First prompt',
            ...overrides
        }))).toBe(title)
    })

    it('formats updatedAt as relative time', () => {
        const now = 1_700_000_000_000

        expect(formatResumeSessionRelativeTime(now - 10_000, now)).toBe('now')
        expect(formatResumeSessionRelativeTime(now - 5 * 60_000, now)).toBe('5m ago')
        expect(formatResumeSessionRelativeTime(now - 3 * 60 * 60_000, now)).toBe('3h ago')
        expect(formatResumeSessionRelativeTime(now - 2 * 24 * 60 * 60_000, now)).toBe('2d ago')
        expect(formatResumeSessionRelativeTime(Math.floor((now - 5 * 60_000) / 1000), now)).toBe('5m ago')
        expect(formatResumeSessionRelativeTime(NaN, now)).toBe('unknown')
    })

    it('filters sessions by searchable fields case-insensitively', () => {
        const sessions = [
            session({
                sessionId: 'alpha',
                name: 'Payment Refactor',
                firstUserMessage: 'Implement billing flow',
                directory: '/repo/api',
                agentSessionId: 'thread-a'
            }),
            session({
                sessionId: 'beta',
                flavor: 'claude',
                directory: '/repo/mobile',
                summary: 'Fix login screen',
                promptTitle: 'Investigate OAuth',
                agentSessionId: 'thread-b'
            }),
            session({
                sessionId: 'gamma',
                active: true,
                controlledByUser: false,
                directory: '/repo/web',
                agentSessionId: 'thread-c'
            })
        ]

        expect(filterResumeSessions(sessions, 'billing').map((item) => item.sessionId)).toEqual(['alpha'])
        expect(filterResumeSessions(sessions, 'PAYMENT').map((item) => item.sessionId)).toEqual(['alpha'])
        expect(filterResumeSessions(sessions, 'oauth').map((item) => item.sessionId)).toEqual(['beta'])
        expect(filterResumeSessions(sessions, 'MOBILE').map((item) => item.sessionId)).toEqual(['beta'])
        expect(filterResumeSessions(sessions, 'thread-c').map((item) => item.sessionId)).toEqual(['gamma'])
        expect(filterResumeSessions(sessions, 'remote').map((item) => item.sessionId)).toEqual(['gamma'])
    })

    it('resets selection and scroll when query changes', () => {
        const initial: PickerState = {
            query: 'abc',
            selectedIndex: 5,
            scrollOffset: 3
        }

        expect(reducePickerState(initial, {
            type: 'char',
            value: 'd'
        }, {
            itemCount: 10,
            visibleCount: 5
        })).toEqual({
            query: 'abcd',
            selectedIndex: 0,
            scrollOffset: 0
        })

        expect(reducePickerState(initial, {
            type: 'key',
            key: 'backspace'
        }, {
            itemCount: 10,
            visibleCount: 5
        })).toEqual({
            query: 'ab',
            selectedIndex: 0,
            scrollOffset: 0
        })
    })

    it('keeps keyboard navigation inside list bounds and visible window', () => {
        let state: PickerState = {
            query: '',
            selectedIndex: 0,
            scrollOffset: 0
        }

        state = reducePickerState(state, { type: 'key', key: 'up' }, {
            itemCount: 20,
            visibleCount: 5
        })
        expect(state.selectedIndex).toBe(0)
        expect(state.scrollOffset).toBe(0)

        state = reducePickerState(state, { type: 'key', key: 'pageDown' }, {
            itemCount: 20,
            visibleCount: 5
        })
        expect(state.selectedIndex).toBe(5)
        expect(state.scrollOffset).toBe(1)

        state = reducePickerState(state, { type: 'key', key: 'end' }, {
            itemCount: 20,
            visibleCount: 5
        })
        expect(state.selectedIndex).toBe(19)
        expect(state.scrollOffset).toBe(15)

        state = reducePickerState(state, { type: 'key', key: 'down' }, {
            itemCount: 20,
            visibleCount: 5
        })
        expect(state.selectedIndex).toBe(19)
        expect(state.scrollOffset).toBe(15)
    })

    it('uses null-equivalent selection when there are no items', () => {
        const state = reducePickerState({
            query: '',
            selectedIndex: 0,
            scrollOffset: 0
        }, {
            type: 'key',
            key: 'down'
        }, {
            itemCount: 0,
            visibleCount: 5
        })

        expect(state.selectedIndex).toBe(0)
        expect(state.scrollOffset).toBe(0)
    })
})
