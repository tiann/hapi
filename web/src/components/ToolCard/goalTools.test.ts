import { describe, expect, it } from 'vitest'
import { isGoalToolName, parseGoalToolResult } from './goalTools'

const goal = {
    threadId: 'thread-1',
    objective: 'Compare the options and validate the chosen approach.',
    status: 'active',
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1704067200,
    updatedAt: 1704067200
}

describe('goal tool results', () => {
    it.each([
        { goal },
        JSON.stringify({ goal }),
        { output: JSON.stringify({ goal }) },
        { result: { content: [{ type: 'text', text: JSON.stringify({ goal }) }] } },
        [{ type: 'text', text: JSON.stringify({ goal }) }],
        goal
    ])('reads the goal snapshot from supported envelopes', (result) => {
        expect(parseGoalToolResult(result)).toEqual({ kind: 'goal', goal })
    })

    it('keeps an explicit empty goal distinct from missing results', () => {
        expect(parseGoalToolResult({ goal: null })).toEqual({ kind: 'empty' })
        expect(parseGoalToolResult(undefined)).toBeNull()
        expect(parseGoalToolResult(null)).toBeNull()
    })

    it.each([
        '{broken',
        'Output:\n' + JSON.stringify({ goal }),
        { data: { goal } },
        { goal: { status: 'active' } },
        { goal: { objective: '  ', status: 'active' } },
        { isError: true, content: [{ type: 'text', text: JSON.stringify({ goal }) }] },
        { error: 'denied', goal },
        { result: { result: { result: { result: { result: { goal } } } } } }
    ])('leaves malformed, error and unrelated results to the generic renderer', (result) => {
        expect(parseGoalToolResult(result)).toBeNull()
    })

    it('normalizes named snake_case fields and preserves zero and null', () => {
        expect(parseGoalToolResult({ goal: {
            objective: goal.objective, status: 'futureState', thread_id: 'thread-2',
            token_budget: null, tokens_used: 0, time_used_seconds: 0,
            created_at: 1704067200
        } })).toEqual({ kind: 'goal', goal: {
            objective: goal.objective, status: 'futureState', threadId: 'thread-2',
            tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1704067200
        } })
    })

    it('does not invent missing counters or display invalid numeric fields', () => {
        expect(parseGoalToolResult({ goal: {
            objective: 'ship', status: 'active', tokensUsed: -1,
            tokenBudget: Infinity, timeUsedSeconds: NaN, updatedAt: -2
        } })).toEqual({ kind: 'goal', goal: { objective: 'ship', status: 'active' } })
        expect(parseGoalToolResult({ goal: { objective: 'ship', status: 'active' } }))
            .toEqual({ kind: 'goal', goal: { objective: 'ship', status: 'active' } })
    })

    it('does not substitute snake_case values for explicit camelCase null', () => {
        expect(parseGoalToolResult({ goal: { ...goal, token_budget: 100 } }))
            .toEqual({ kind: 'goal', goal })
    })

    it('stops at the nesting limit and handles circular objects', () => {
        const cycle: { result?: unknown } = {}
        cycle.result = cycle
        expect(parseGoalToolResult(cycle)).toBeNull()
    })
})

describe('goal tool names', () => {
    it.each(['create_goal', 'get_goal', 'update_goal', 'functions.create_goal', 'functions.get_goal', 'functions.update_goal'])
        ('recognizes %s', (name) => expect(isGoalToolName(name)).toBe(true))

    it.each(['mcp__other__create_goal', 'other.create_goal', 'recreate_goal', 'functions.functions.create_goal', 'Create_Goal', 'create_goal_extra'])
        ('does not claim unrelated tool %s', (name) => expect(isGoalToolName(name)).toBe(false))
})


describe('goal status messages', () => {
    it('recognizes the complete slash-command response', async () => {
        const { parseGoalStatusMessage } = await import('./goalTools')
        expect(parseGoalStatusMessage(JSON.stringify({ goal }))).toEqual({ kind: 'goal', goal })
        expect(parseGoalStatusMessage('{"goal":null}')).toEqual({ kind: 'empty' })
    })

    it.each([
        JSON.stringify(goal),
        JSON.stringify({ goal, error: 'denied' }),
        JSON.stringify({ result: { goal } }),
        JSON.stringify({ goal, unrelated: true }),
        JSON.stringify({ goal: { objective: 'incomplete' } }),
        '```json\n' + JSON.stringify({ goal }) + '\n```',
        'Goal result: ' + JSON.stringify({ goal }),
        '{broken'
    ])('leaves unrelated and malformed status messages unchanged', async (message) => {
        const { parseGoalStatusMessage } = await import('./goalTools')
        expect(parseGoalStatusMessage(message)).toBeNull()
    })
})
